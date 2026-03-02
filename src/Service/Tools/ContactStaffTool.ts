import { HttpService } from '@nestjs/axios';
import { SlackService } from 'nestjs-slack';
import { AskQuestionDto } from '../../Dto/askQuestion.dto';
import { BuildEscalatedAnswerTemplate } from '../Slack/build-escalated-answer-template.service';
import { Injectable } from '@nestjs/common';
import { EscalationRequestDto } from '../../Dto/escalation-request.dto';
import { firstValueFrom } from 'rxjs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import https from 'https';
import * as Sentry from '@sentry/nestjs';
import { buildAdminRequestOptions } from '../Utils/admin-request-options';

@Injectable()
export class ContactStaffTool {
  constructor(
    private readonly httpService: HttpService,
    private readonly slackService: SlackService,
    private readonly buildEscalatedAnswerTemplate: BuildEscalatedAnswerTemplate,
  ) {
    this.httpService = httpService;
    this.slackService = slackService;
    this.buildEscalatedAnswerTemplate = buildEscalatedAnswerTemplate;
  }

  public build(request: AskQuestionDto, signal?: AbortSignal): DynamicStructuredTool {
    const languageNames: Record<string, string> = {
      en: 'English',
      es: 'Spanish',
      pt: 'Portuguese',
    };
    const targetLanguageKey = (request.hostLanguage || 'en')
      .toLowerCase()
      .split('-')[0];
    const targetLanguage =
      languageNames[targetLanguageKey] ?? languageNames.en;
    return new DynamicStructuredTool({
      name: 'contact_staff',
      schema: z.object({
        query: z
          .string()
          .describe(
            `Summarize the guest's situation in one clear, factual sentence, capturing the core issue and any guest emotion. Write this summary in ${targetLanguage}.`,
          ),
        context: z
          .string()
          .describe(
            `List up to three concise actions the staff should take to resolve the issue without repeating the summary, keeping the instructions under 60 words. Write these action steps in ${targetLanguage}.`,
          ),
        priority: z
          .enum(['1', '2', '3'])
          .describe(
            'Set the priority based on urgency and impact: "1" = HIGH (immediate safety risk, severe service failure, or needs action within 1 hour), "2" = NORMAL (time-sensitive within the same day or affects upcoming stay), "3" = LOW (informational or non-urgent follow-up).',
          ),
      }),
      description:
        'Escalate guest issues that require immediate human assistance from the staff team.',
      func: async ({ query, context, priority }) =>
        this.handleEscalation(request, query, context, priority, signal),
    });
  }

  public async handleEscalation(
    request: AskQuestionDto,
    query: string,
    context: string,
    priority: '1' | '2' | '3',
    signal?: AbortSignal,
  ): Promise<string> {
    const escalationRequest: EscalationRequestDto = {
      conciergeSummary: context,
      guestRequest: query,
      bookingId: request.bookingId,
      locationId: request.locationId,
      hostId: request.hostId,
      chatId: request.chatId,
      chatMessageId: request.chatMessageId,
      priority: priority,
    };

    const response = await this.reportEscalation(escalationRequest, signal);

    if ('failed' in response && response.failed) {
      return JSON.stringify({
        status: 'failed',
        message: "I'm having trouble reaching staff right now.",
      });
    }

    // At this point, response is guaranteed to be IncidentResponse
    const incidentResponse = response as IncidentResponse;

    const toolResponse: ContactStaffToolResult = {
      status: 'escalated',
      messageFromStaff: 'Not confirmed. Need to review.',
    };

    const staffNote = incidentResponse.incident?.note;
    const normalizedNote =
      typeof staffNote === 'string' ? staffNote.trim() : undefined;

    if (normalizedNote) {
      return JSON.stringify({
        ...toolResponse,
        note: normalizedNote,
      });
    }

    return JSON.stringify(toolResponse);
  }

  private async reportEscalation(
    escalationRequest: EscalationRequestDto,
    signal?: AbortSignal,
  ): Promise<IncidentResponse | EscalationFailedResponse> {
    try {
      await this.slackService.sendBlocks(
        this.buildEscalatedAnswerTemplate.execute({
          hostId: escalationRequest.hostId,
          bookingId: escalationRequest.bookingId,
          locationId: escalationRequest.locationId,
          question: escalationRequest.guestRequest,
          answer: '',
          evaluation: escalationRequest.conciergeSummary,
          chatId: escalationRequest.chatId,
          chatMessageId: escalationRequest.chatMessageId,
          priority: escalationRequest.priority,
        }),
        { channel: 'escalation' },
      );
    } catch (error) {
      Sentry.setContext('escalation', {
        hostId: escalationRequest.hostId,
        bookingId: escalationRequest.bookingId,
        locationId: escalationRequest.locationId,
        priority: escalationRequest.priority,
      });
      Sentry.captureException(error);
    }

    const url = `${process.env.ADMIN_INSTANCE_URL}api/ai/report-escalation`;
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    const maxRetries = 3;
    const baseDelayMs = 1000;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {const response = await firstValueFrom(
      this.httpService.post(
        url,
        escalationRequest,
            buildAdminRequestOptions({ httpsAgent, signal }),
          ),
        );
        return response.data as IncidentResponse;
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          await this.sleep(delayMs);
        }
      }
    }

    Sentry.setContext('escalation', {
      hostId: escalationRequest.hostId,
      bookingId: escalationRequest.bookingId,
      locationId: escalationRequest.locationId,
      priority: escalationRequest.priority,
      retriesAttempted: maxRetries,
    });
    Sentry.captureException(lastError);

    return { failed: true };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface ContactStaffToolResult {
  status: 'escalated';
  messageFromStaff: 'Not confirmed. Need to review.';
  note?: string;
}

interface IncidentResponse {
  incident?: {
    id?: string;
    note?: string;
    status?: string;
  };
}

interface EscalationFailedResponse {
  failed: true;
}
