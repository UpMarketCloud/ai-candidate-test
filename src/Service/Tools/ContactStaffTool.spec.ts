import { ContactStaffTool } from './ContactStaffTool';
import { HttpService } from '@nestjs/axios';
import { SlackService } from 'nestjs-slack';
import { BuildEscalatedAnswerTemplate } from '../Slack/build-escalated-answer-template.service';
import { of } from 'rxjs';
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
});
