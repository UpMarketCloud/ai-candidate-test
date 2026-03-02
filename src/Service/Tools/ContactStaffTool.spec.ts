import {
  ContactStaffTool,
  SimilarityChecker,
  SIMILARITY_PROMPT_TEMPLATE,
  formatEscalationsForPrompt,
  ExistingEscalation,
  SimilarityResult,
} from './ContactStaffTool';
import { HttpService } from '@nestjs/axios';
import { SlackService } from 'nestjs-slack';
import { BuildEscalatedAnswerTemplate } from '../Slack/build-escalated-answer-template.service';
import { of, throwError } from 'rxjs';
import { AskQuestionDto } from '../../Dto/askQuestion.dto';

describe('ContactStaffTool', () => {
  let httpService: HttpService;
  let slackService: SlackService;
  let buildEscalatedAnswerTemplate: BuildEscalatedAnswerTemplate;
  let tool: ContactStaffTool;
  const originalAdminUrl = process.env.ADMIN_INSTANCE_URL;
  const originalAdminApiKey = process.env.ADMIN_INSTANCE_X_API_KEY;

  beforeEach(() => {
    httpService = {
      post: jest.fn(),
      get: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
    } as unknown as HttpService;
    slackService = { sendBlocks: jest.fn() } as unknown as SlackService;
    buildEscalatedAnswerTemplate = {
      execute: jest.fn().mockReturnValue('slack-blocks'),
    } as unknown as BuildEscalatedAnswerTemplate;

    tool = new ContactStaffTool(
      httpService,
      slackService,
      buildEscalatedAnswerTemplate,
    );

    process.env.ADMIN_INSTANCE_URL = 'https://admin/';
    process.env.ADMIN_INSTANCE_X_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    jest.resetAllMocks();
    process.env.ADMIN_INSTANCE_URL = originalAdminUrl;
    process.env.ADMIN_INSTANCE_X_API_KEY = originalAdminApiKey;
  });

  const buildRequest = (overrides: Partial<AskQuestionDto> = {}): AskQuestionDto =>
    ({
      hostLanguage: 'en',
      bookingId: 'booking-1',
      locationId: 'location-1',
      hostId: 'host-1',
      chatId: 'chat-1',
      chatMessageId: 'message-1',
      ...overrides,
    } as AskQuestionDto);

  const buildMockSimilarityChecker = (result: SimilarityResult): SimilarityChecker => ({
    checkSimilarity: jest.fn().mockResolvedValue(result),
  });

  const buildExistingEscalation = (overrides: Partial<ExistingEscalation> = {}): ExistingEscalation => ({
    id: 'esc-001',
    guestRequest: 'No hot water in room 302',
    conciergeSummary: '1. Check boiler. 2. Offer room change.',
    status: 'open',
    priority: '2',
    createdAt: '2026-02-28T10:00:00Z',
    ...overrides,
  });

  // --- Original Tests (preserved) --------------------------------------------

  it('builds a localized tool schema using the mapped host language', () => {
    const request = buildRequest({ hostLanguage: 'pt-BR' });

    const dynamicTool = tool.build(request);
    const schema: any = dynamicTool.schema;

    expect(dynamicTool.name).toBe('contact_staff');
    expect(dynamicTool.description).toBe(
      'Escalate guest issues that require immediate human assistance from the staff team.',
    );
    expect(schema.shape.query.description).toContain('Portuguese');
    expect(schema.shape.query.description).toContain(
      "Summarize the guest's situation in one clear, factual sentence",
    );
    expect(schema.shape.context.description).toContain('Portuguese');
    expect(schema.shape.context.description).toContain('under 60 words');
    expect(schema.shape.priority._def.description).toContain('HIGH (immediate safety risk');
  });

  it('defaults instructions to English when the host language is missing', () => {
    const request = buildRequest({ hostLanguage: undefined as unknown as string });

    const dynamicTool = tool.build(request);
    const schema: any = dynamicTool.schema;

    expect(schema.shape.query.description).toContain('English');
    expect(schema.shape.context.description).toContain('English');
  });

  it('reports escalations and returns staff notes when available', async () => {
    const incidentNote = '  Check the circuit breaker in the utility closet.  ';

    // GET: no existing escalations
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(
      of({ data: { incident: { note: incidentNote } } }),
    );

    const request = buildRequest({ hostLanguage: 'es-MX' });
    const dynamicTool = tool.build(request);

    const result = await dynamicTool.func({
      query: 'La huésped no tiene electricidad en la sala.',
      context: '1. Contactar al electricista de guardia. 2. Confirmar disponibilidad.',
      priority: '1',
    });

    expect(buildEscalatedAnswerTemplate.execute).toHaveBeenCalledWith({
      hostId: 'host-1',
      bookingId: 'booking-1',
      locationId: 'location-1',
      question: 'La huésped no tiene electricidad en la sala.',
      answer: '',
      evaluation: '1. Contactar al electricista de guardia. 2. Confirmar disponibilidad.',
      chatId: 'chat-1',
      chatMessageId: 'message-1',
      priority: '1',
    });
    expect(slackService.sendBlocks).toHaveBeenCalledWith('slack-blocks', {
      channel: 'escalation',
    });
    expect(httpService.post).toHaveBeenCalledWith(
      'https://admin/api/ai/report-escalation',
      {
        conciergeSummary: '1. Contactar al electricista de guardia. 2. Confirmar disponibilidad.',
        guestRequest: 'La huésped no tiene electricidad en la sala.',
        bookingId: 'booking-1',
        locationId: 'location-1',
        hostId: 'host-1',
        chatId: 'chat-1',
        chatMessageId: 'message-1',
        priority: '1',
      },
      {
        httpsAgent: expect.any(Object),
        headers: expect.objectContaining({ 'X-API-KEY': 'test-api-key' }),
      },
    );
    expect(typeof result).toBe('string');
    expect(JSON.parse(result)).toEqual({
      status: 'escalated',
      messageFromStaff: 'Not confirmed. Need to review.',
      note: 'Check the circuit breaker in the utility closet.',
    });
  });

  it('omits the note when the incident response includes only whitespace', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(
      of({ data: { incident: { note: '   ' } } }),
    );

    const request = buildRequest();
    const dynamicTool = tool.build(request);

    const result = await dynamicTool.func({
      query: 'Guest cannot access the Wi-Fi network.',
      context: 'Verify router status and reset remotely if needed.',
      priority: '3',
    });

    expect(typeof result).toBe('string');
    expect(JSON.parse(result)).toEqual({
      status: 'escalated',
      messageFromStaff: 'Not confirmed. Need to review.',
    });
  });

  it('returns the default escalation acknowledgement when staff has not provided notes yet', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

    const request = buildRequest();
    const dynamicTool = tool.build(request);

    const result = await dynamicTool.func({
      query: 'Power outage in the main hall.',
      context: 'Coordinate with maintenance to inspect the breaker panel.',
      priority: '2',
    });

    expect(buildEscalatedAnswerTemplate.execute).toHaveBeenCalledWith({
      hostId: 'host-1',
      bookingId: 'booking-1',
      locationId: 'location-1',
      question: 'Power outage in the main hall.',
      answer: '',
      evaluation: 'Coordinate with maintenance to inspect the breaker panel.',
      chatId: 'chat-1',
      chatMessageId: 'message-1',
      priority: '2',
    });
    expect(slackService.sendBlocks).toHaveBeenCalledWith('slack-blocks', {
      channel: 'escalation',
    });
    expect(httpService.post).toHaveBeenCalledWith(
      'https://admin/api/ai/report-escalation',
      {
        conciergeSummary: 'Coordinate with maintenance to inspect the breaker panel.',
        guestRequest: 'Power outage in the main hall.',
        bookingId: 'booking-1',
        locationId: 'location-1',
        hostId: 'host-1',
        chatId: 'chat-1',
        chatMessageId: 'message-1',
        priority: '2',
      },
      {
        httpsAgent: expect.any(Object),
        headers: expect.objectContaining({ 'X-API-KEY': 'test-api-key' }),
      },
    );
    expect(typeof result).toBe('string');
    expect(JSON.parse(result)).toEqual({
      status: 'escalated',
      messageFromStaff: 'Not confirmed. Need to review.',
    });
  });

  it('omits API key header when ADMIN_INSTANCE_X_API_KEY is not set', async () => {
    delete process.env.ADMIN_INSTANCE_X_API_KEY;
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

    const request = buildRequest();
    const dynamicTool = tool.build(request);

    await dynamicTool.func({
      query: 'Test missing key',
      context: 'No key scenario',
      priority: '2',
    });

    const callArgs = (httpService.post as jest.Mock).mock.calls[0];
    expect(callArgs[2].headers?.['X-API-KEY']).toBeUndefined();
  });

  it('passes signal to HTTP request when provided', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));
    const controller = new AbortController();

    const request = buildRequest();
    const dynamicTool = tool.build(request, controller.signal);

    await dynamicTool.func({
      query: 'Test with signal',
      context: 'Signal propagation test',
      priority: '2',
    });

    const callArgs = (httpService.post as jest.Mock).mock.calls[0];
    expect(callArgs[2].signal).toBe(controller.signal);
  });

  it('does not include signal when not provided', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      of({ data: { escalations: [] } }),
    );
    (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

    const request = buildRequest();
    const dynamicTool = tool.build(request);

    await dynamicTool.func({
      query: 'Test without signal',
      context: 'No signal test',
      priority: '2',
    });

    const callArgs = (httpService.post as jest.Mock).mock.calls[0];
    expect(callArgs[2].signal).toBeUndefined();
  });

  // --- Escalation-Aware Behavior Tests ---------------------------------------

  // Proves lifecycle-aware decision-making across create/update/skip/reopen branches.
  describe('escalation-aware behavior', () => {
    // Proves existing-escalation lookup behavior and request scoping.
    describe('fetching existing escalations', () => {
      it('fetches existing escalations with chatId and bookingId before creating', async () => {
        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-new' } } }),
        );

        const request = buildRequest();
        const dynamicTool = tool.build(request);

        await dynamicTool.func({
          query: 'The pool is closed unexpectedly',
          context: '1. Check pool maintenance schedule.',
          priority: '3',
        });

        expect(httpService.get).toHaveBeenCalledWith(
          'https://admin/api/ai/escalations?chatId=chat-1&bookingId=booking-1',
          expect.objectContaining({
            httpsAgent: expect.any(Object),
            headers: expect.objectContaining({ 'X-API-KEY': 'test-api-key' }),
          }),
        );
        expect(httpService.post).toHaveBeenCalled();
      });

      it('fetches escalations with only chatId when bookingId is missing', async () => {
        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

        const request = buildRequest({ bookingId: undefined });
        const dynamicTool = tool.build(request);

        await dynamicTool.func({
          query: 'General inquiry',
          context: 'Follow up',
          priority: '3',
        });

        expect(httpService.get).toHaveBeenCalledWith(
          'https://admin/api/ai/escalations?chatId=chat-1',
          expect.any(Object),
        );
      });

      it('skips fetching escalations and creates directly when chatId is missing', async () => {
        (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

        const request = buildRequest({ chatId: undefined });
        const dynamicTool = tool.build(request);

        await dynamicTool.func({
          query: 'Issue without chat context',
          context: 'Handle it',
          priority: '2',
        });

        expect(httpService.get).not.toHaveBeenCalled();
        expect(httpService.post).toHaveBeenCalled();
      });
    });

    // Proves default behavior when no previous escalations exist.
    describe('no existing escalations', () => {
      it('creates a new escalation when no existing ones are found', async () => {
        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-123' } } }),
        );

        const request = buildRequest();
        const dynamicTool = tool.build(request);

        const result = await dynamicTool.func({
          query: 'The pool is closed unexpectedly',
          context: '1. Check pool maintenance schedule.',
          priority: '3',
        });

        expect(httpService.get).toHaveBeenCalled();
        expect(httpService.post).toHaveBeenCalled();
        expect(JSON.parse(result)).toEqual(
          expect.objectContaining({ status: 'escalated' }),
        );
      });
    });

    // Proves safe fallback behavior when similarity checker is not configured.
    describe('existing escalations without similarity checker', () => {
      it('creates a new escalation when no similarity checker is provided', async () => {
        // Tool without similarity checker (default constructor)
        (httpService.get as jest.Mock).mockReturnValue(
          of({
            data: {
              escalations: [buildExistingEscalation()],
            },
          }),
        );
        (httpService.post as jest.Mock).mockReturnValue(of({ data: {} }));

        const request = buildRequest();
        const dynamicTool = tool.build(request);

        const result = await dynamicTool.func({
          query: 'No hot water in room 302',
          context: 'Check boiler',
          priority: '2',
        });

        // Without similarity checker, it should create new escalation
        expect(httpService.post).toHaveBeenCalled();
        expect(JSON.parse(result)).toEqual(
          expect.objectContaining({ status: 'escalated' }),
        );
      });
    });

    // Proves dedupe logic for open matched escalations (retry/skip/update).
    describe('similar open escalation found', () => {
      it('retries similarity once when matchedEscalationId is not in fetched list', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-001',
          status: 'open',
          priority: '2',
        });

        const similarityChecker: SimilarityChecker = {
          checkSimilarity: jest
            .fn()
            .mockResolvedValueOnce({
              isSimilar: true,
              matchedEscalationId: 'esc-missing',
              confidence: 'medium',
              reasoning: 'Likely similar',
            })
            .mockResolvedValueOnce({
              isSimilar: true,
              matchedEscalationId: 'esc-001',
              confidence: 'high',
              reasoning: 'Corrected ID after retry',
            }),
        };

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...existingEscalation } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Still no hot water',
          context: 'Please follow up with maintenance.',
          priority: '2',
        });

        expect(similarityChecker.checkSimilarity).toHaveBeenCalledTimes(2);
        expect(similarityChecker.checkSimilarity).toHaveBeenNthCalledWith(
          2,
          'Still no hot water',
          [existingEscalation],
          { invalidMatchedEscalationId: 'esc-missing' },
        );
        expect(httpService.put).toHaveBeenCalled();
        expect(JSON.parse(result)).toEqual(
          expect.objectContaining({ status: 'updated' }),
        );
      });

      it('skips updating when the escalation is open but no meaningful new details are provided', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-skip-001',
          guestRequest: 'No hot water in room 302',
          conciergeSummary: 'Check boiler and confirm ETA with maintenance.',
          status: 'open',
          priority: '2',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-skip-001',
          confidence: 'high',
          reasoning: 'Same underlying issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Any update on the hot water issue?',
          context: 'Check boiler and confirm ETA with maintenance.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('skipped');
        expect(parsed.escalationId).toBe('esc-skip-001');
        expect(parsed.message).toContain('already working on this issue');
        expect(httpService.put).not.toHaveBeenCalled();
        expect(httpService.post).not.toHaveBeenCalled();
      });

      it('updates the existing escalation instead of creating a duplicate', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-001',
          guestRequest: 'No hot water in room 302',
          status: 'open',
          priority: '2',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-001',
          confidence: 'high',
          reasoning: 'Both about hot water issue in room 302',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...existingEscalation } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'The shower is still ice cold',
          context: 'Guest is frustrated. Follow up with maintenance.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('updated');
        expect(parsed.escalationId).toBe('esc-001');
        expect(parsed.message).toContain('already looking into this');
        expect(httpService.post).not.toHaveBeenCalled();
        expect(httpService.put).toHaveBeenCalledWith(
          'https://admin/api/ai/escalations/esc-001',
          expect.objectContaining({
            guestRequest: 'The shower is still ice cold',
            conciergeSummary: expect.stringContaining('Updated context'),
          }),
          expect.any(Object),
        );
      });

      it('upgrades priority when new request has higher priority than existing', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-002',
          status: 'open',
          priority: '3', // LOW
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-002',
          confidence: 'high',
          reasoning: 'Same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...existingEscalation, priority: '1' } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Hot water issue is now urgent',
          context: 'Guest has a medical condition.',
          priority: '1', // HIGH — higher than existing '3'
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('updated');
        expect(parsed.priorityUpgraded).toBe(true);
        expect(parsed.message).toContain('priority has been upgraded');

        const putCallArgs = (httpService.put as jest.Mock).mock.calls[0];
        expect(putCallArgs[1].priority).toBe('1');
      });

      it('does not upgrade priority when new request has same or lower priority', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-003',
          status: 'open',
          priority: '1', // Already HIGH
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-003',
          confidence: 'high',
          reasoning: 'Same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...existingEscalation } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Follow-up on the hot water issue',
          context: 'Just checking in.',
          priority: '3', // LOW — lower than existing '1'
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('updated');
        expect(parsed.priorityUpgraded).toBeUndefined();

        const putCallArgs = (httpService.put as jest.Mock).mock.calls[0];
        expect(putCallArgs[1].priority).toBeUndefined();
      });

      it('appends new context to the existing escalation summary', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-004',
          conciergeSummary: 'Original context from first report.',
          status: 'open',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-004',
          confidence: 'medium',
          reasoning: 'Related to same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...existingEscalation } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        await dynamicTool.func({
          query: 'Also the bathroom light is flickering',
          context: 'Check electrical panel for the room.',
          priority: '2',
        });

        const putCallArgs = (httpService.put as jest.Mock).mock.calls[0];
        const sentSummary = putCallArgs[1].conciergeSummary;
        expect(sentSummary).toContain('Original context from first report.');
        expect(sentSummary).toContain('Check electrical panel for the room.');
        expect(sentSummary).toContain('Updated context');
      });
    });

    // Proves recurring-issue handling when matched escalation is already resolved.
    describe('similar resolved escalation found (recurring issue)', () => {
      it('creates a new escalation with elevated priority for recurring issues', async () => {
        const resolvedEscalation = buildExistingEscalation({
          id: 'esc-resolved-001',
          guestRequest: 'No hot water in room 302',
          status: 'resolved',
          priority: '2',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-resolved-001',
          confidence: 'high',
          reasoning: 'Same hot water issue that was previously resolved',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [resolvedEscalation] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-new-001' } } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'The hot water is gone again',
          context: 'Check boiler again. Issue is recurring.',
          priority: '3', // LOW originally
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('reopened');
        expect(parsed.previousEscalationId).toBe('esc-resolved-001');
        expect(parsed.message).toContain('previously resolved');
        expect(parsed.message).toContain('resurfaced');
        expect(parsed.escalationId).toBe('inc-new-001');
        expect(parsed.priorityElevated).toBe(true);

        // Verify the POST was called with elevated priority (3 -> 2)
        const postCallArgs = (httpService.post as jest.Mock).mock.calls[0];
        expect(postCallArgs[1].priority).toBe('2');
        expect(postCallArgs[1].conciergeSummary).toContain('RECURRING ISSUE');
        expect(postCallArgs[1].conciergeSummary).toContain('esc-resolved-001');
      });

      it('keeps priority at 1 when already highest for recurring issues', async () => {
        const resolvedEscalation = buildExistingEscalation({
          id: 'esc-resolved-002',
          status: 'resolved',
          priority: '1',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-resolved-002',
          confidence: 'high',
          reasoning: 'Same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [resolvedEscalation] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-new-002' } } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Same issue again',
          context: 'Check again.',
          priority: '1', // Already highest
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('reopened');
        expect(parsed.priorityElevated).toBe(false); // Can't go higher than 1

        const postCallArgs = (httpService.post as jest.Mock).mock.calls[0];
        expect(postCallArgs[1].priority).toBe('1');
      });
    });

    // Proves unrelated issues create a new escalation instead of updating an existing one.
    describe('different issue from existing escalations', () => {
      it('creates a new escalation when similarity checker says not similar', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-wifi',
          guestRequest: 'Wi-Fi is not working',
          status: 'open',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: false,
          matchedEscalationId: null,
          confidence: 'high',
          reasoning: 'Hot water and Wi-Fi are completely different issues',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-hotwater' } } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'No hot water in the room',
          context: 'Check boiler.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('escalated');
        expect(httpService.post).toHaveBeenCalled();
        expect(httpService.put).not.toHaveBeenCalled();
      });
    });

    describe('error handling — fetch escalations fails', () => {
      it('gracefully degrades to creating a new escalation when GET fails', async () => {
        (httpService.get as jest.Mock).mockReturnValue(
          throwError(() => new Error('Network error')),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-fallback' } } }),
        );

        const request = buildRequest();
        const dynamicTool = tool.build(request);

        const result = await dynamicTool.func({
          query: 'Guest locked out of room',
          context: 'Send security to room 405.',
          priority: '1',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('escalated');
        expect(httpService.post).toHaveBeenCalled();
      });
    });

    describe('error handling — update escalation fails', () => {
      it('falls back to creating a new escalation when PUT fails', async () => {
        const existingEscalation = buildExistingEscalation({
          id: 'esc-fail-update',
          status: 'open',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-fail-update',
          confidence: 'high',
          reasoning: 'Same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [existingEscalation] } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          throwError(() => new Error('Update failed')),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          of({ data: { incident: { id: 'inc-fallback-create' } } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Follow-up on the issue',
          context: 'Additional details.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        // Falls back to creating a new escalation
        expect(parsed.status).toBe('escalated');
        expect(httpService.post).toHaveBeenCalled();
      });
    });

    describe('error handling — create escalation fails after recurring detection', () => {
      it('returns failed status when POST fails for recurring escalation', async () => {
        const resolvedEscalation = buildExistingEscalation({
          id: 'esc-resolved-fail',
          status: 'resolved',
        });

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-resolved-fail',
          confidence: 'high',
          reasoning: 'Same issue',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations: [resolvedEscalation] } }),
        );
        (httpService.post as jest.Mock).mockReturnValue(
          throwError(() => new Error('Server error')),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'Issue is back',
          context: 'Recurring problem.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('failed');
        expect(parsed.message).toContain('trouble reaching staff');
      }, 30000);
    });

    // Proves similarity-selected escalation is used when multiple candidates exist.
    describe('multiple existing escalations', () => {
      it('correctly matches against the right escalation among multiple', async () => {
        const escalations: ExistingEscalation[] = [
          buildExistingEscalation({
            id: 'esc-wifi',
            guestRequest: 'Wi-Fi is not working',
            status: 'open',
            priority: '3',
          }),
          buildExistingEscalation({
            id: 'esc-hotwater',
            guestRequest: 'No hot water',
            status: 'open',
            priority: '2',
          }),
        ];

        const similarityChecker = buildMockSimilarityChecker({
          isSimilar: true,
          matchedEscalationId: 'esc-hotwater',
          confidence: 'high',
          reasoning: 'Both about hot water',
        });

        const toolWithChecker = new ContactStaffTool(
          httpService,
          slackService,
          buildEscalatedAnswerTemplate,
          similarityChecker,
        );

        (httpService.get as jest.Mock).mockReturnValue(
          of({ data: { escalations } }),
        );
        (httpService.put as jest.Mock).mockReturnValue(
          of({ data: { ...escalations[1] } }),
        );

        const request = buildRequest();
        const dynamicTool = toolWithChecker.build(request);

        const result = await dynamicTool.func({
          query: 'The shower is still cold',
          context: 'Check boiler again.',
          priority: '2',
        });

        const parsed = JSON.parse(result);
        expect(parsed.status).toBe('updated');
        expect(parsed.escalationId).toBe('esc-hotwater');

        // Verify similarity checker received all escalations
        expect(similarityChecker.checkSimilarity).toHaveBeenCalledWith(
          'The shower is still cold',
          escalations,
        );
      });
    });
  });

  // --- Prompt Template and Utility Tests -------------------------------------

  // Proves prompt quality and output contract for similarity decisions.
  describe('similarity prompt template', () => {
    it('contains the required placeholders', () => {
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('{newQuery}');
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('{existingEscalations}');
    });

    it('includes instructions for same and different issue classification', () => {
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('SAME issue');
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('DIFFERENT issues');
    });

    it('specifies the expected JSON response structure', () => {
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('isSimilar');
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('matchedEscalationId');
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('confidence');
      expect(SIMILARITY_PROMPT_TEMPLATE).toContain('reasoning');
    });
  });

  // Proves escalation formatting utility used to build similarity prompt context.
  describe('formatEscalationsForPrompt', () => {
    it('formats escalations into a readable list', () => {
      const escalations: ExistingEscalation[] = [
        buildExistingEscalation({
          id: 'esc-001',
          guestRequest: 'No hot water',
          conciergeSummary: 'Check boiler and offer room change.',
          status: 'open',
          priority: '2',
        }),
        buildExistingEscalation({
          id: 'esc-002',
          guestRequest: 'Wi-Fi broken',
          conciergeSummary: 'Reboot router and verify room signal.',
          status: 'resolved',
          priority: '3',
        }),
      ];

      const formatted = formatEscalationsForPrompt(escalations);

      expect(formatted).toContain('[1] ID: esc-001');
      expect(formatted).toContain('Status: open');
      expect(formatted).toContain('Issue: "No hot water"');
      expect(formatted).toContain('Summary: "Check boiler and offer room change."');
      expect(formatted).toContain('[2] ID: esc-002');
      expect(formatted).toContain('Status: resolved');
      expect(formatted).toContain('Issue: "Wi-Fi broken"');
      expect(formatted).toContain('Summary: "Reboot router and verify room signal."');
    });

    it('returns empty string for empty escalations array', () => {
      expect(formatEscalationsForPrompt([])).toBe('');
    });
  });
});

