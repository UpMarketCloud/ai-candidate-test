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
    private readonly similarityChecker?: SimilarityChecker,
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
    // Build the canonical escalation payload once so all branches share the same base data.
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

    // Fetch existing escalations to make intelligent decisions
    const existingEscalations = await this.fetchExistingEscalations(
      request.chatId,
      request.bookingId,
      signal,
    );

    // If there are existing escalations, try to match this request to an existing issue.
    if (existingEscalations.length > 0 && this.similarityChecker) {
      const similarityResult = await this.similarityChecker.checkSimilarity(
        query,
        existingEscalations,
      );

      if (similarityResult.isSimilar && similarityResult.matchedEscalationId) {
        let matchedEscalation = existingEscalations.find(
          (e) => e.id === similarityResult.matchedEscalationId,
        );

        if (!matchedEscalation) {
          // One retry: similarity can return an invalid ID; give it a corrected second attempt.
          const retrySimilarityResult =
            await this.similarityChecker.checkSimilarity(
              query,
              existingEscalations,
              {
                invalidMatchedEscalationId:
                  similarityResult.matchedEscalationId,
              },
            );

          if (
            retrySimilarityResult.isSimilar &&
            retrySimilarityResult.matchedEscalationId
          ) {
            matchedEscalation = existingEscalations.find(
              (e) => e.id === retrySimilarityResult.matchedEscalationId,
            );
          }
        }

        if (matchedEscalation) {
          return this.handleMatchedEscalation(
            matchedEscalation,
            escalationRequest,
            query,
            context,
            priority,
            signal,
          );
        }
      }
    }

    // No similar match found (or no checker available): create a new escalation.
    const response = await this.reportEscalation(escalationRequest, signal);

    if ('failed' in response && response.failed) {
      return JSON.stringify({
        status: 'failed',
        message: "I'm having trouble reaching staff right now.",
      });
    }

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

  private async handleMatchedEscalation(
    matchedEscalation: ExistingEscalation,
    escalationRequest: EscalationRequestDto,
    query: string,
    context: string,
    priority: '1' | '2' | '3',
    signal?: AbortSignal,
  ): Promise<string> {
    if (matchedEscalation.status === 'open') {
      // Existing open escalation: only update when there is new context or higher urgency.
      const shouldUpgradePriority =
        this.comparePriority(priority, matchedEscalation.priority) > 0;
      const hasMeaningfulContextUpdate = this.hasMeaningfulContextUpdate(
        matchedEscalation.conciergeSummary,
        context,
      );

      if (!shouldUpgradePriority && !hasMeaningfulContextUpdate) {
        // Guest is following up without new actionable details: avoid noisy duplicate updates.
        const skippedResponse: EscalationSkippedResult = {
          status: 'skipped',
          escalationId: matchedEscalation.id,
          message:
            'Our team is already working on this issue. We will share updates as soon as possible.',
        };
        return JSON.stringify(skippedResponse);
      }

      const updatePayload: EscalationUpdatePayload = {
        guestRequest: query,
        conciergeSummary: `${matchedEscalation.conciergeSummary}\n\n--- Updated context ---\n${context}`,
      };

      if (shouldUpgradePriority) {
        updatePayload.priority = priority;
      }

      const updated = await this.updateEscalation(
        matchedEscalation.id,
        updatePayload,
        signal,
      );

      if (!updated) {
        // Update failed, fall back to creating a new escalation
        return this.fallbackToCreate(escalationRequest, signal);
      }

      const response: EscalationUpdatedResult = {
        status: 'updated',
        escalationId: matchedEscalation.id,
        message: 'Our team is already looking into this. The escalation has been updated with the new details.',
      };

      if (shouldUpgradePriority) {
        response.priorityUpgraded = true;
        response.message =
          'Our team is already looking into this. The priority has been upgraded and the escalation updated with the new details.';
      }

      return JSON.stringify(response);
    }

    if (matchedEscalation.status === 'resolved') {
      // Issue resurfaced after resolution: open a new recurring escalation with elevated priority.
      const escalatedPriority = this.elevatePriority(priority);

      const recurringRequest: EscalationRequestDto = {
        ...escalationRequest,
        priority: escalatedPriority,
        conciergeSummary: `[RECURRING ISSUE — previously resolved as ${matchedEscalation.id}]\n${context}`,
      };

      const response = await this.reportEscalation(recurringRequest, signal);

      if ('failed' in response && response.failed) {
        return JSON.stringify({
          status: 'failed',
          message: "I'm having trouble reaching staff right now.",
        });
      }

      const incidentResponse = response as IncidentResponse;

      return JSON.stringify({
        status: 'reopened',
        previousEscalationId: matchedEscalation.id,
        message:
          'This issue was previously resolved but has resurfaced. A new escalation has been created with higher priority.',
        escalationId: incidentResponse.incident?.id,
        priorityElevated: escalatedPriority !== priority,
      });
    }

    // Fallback for any unexpected status
    return this.fallbackToCreate(escalationRequest, signal);
  }

  private async fallbackToCreate(
    escalationRequest: EscalationRequestDto,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.reportEscalation(escalationRequest, signal);

    if ('failed' in response && response.failed) {
      return JSON.stringify({
        status: 'failed',
        message: "I'm having trouble reaching staff right now.",
      });
    }

    const incidentResponse = response as IncidentResponse;

    const toolResponse: ContactStaffToolResult = {
      status: 'escalated',
      messageFromStaff: 'Not confirmed. Need to review.',
    };

    const staffNote = incidentResponse.incident?.note;
    const normalizedNote =
      typeof staffNote === 'string' ? staffNote.trim() : undefined;

    if (normalizedNote) {
      return JSON.stringify({ ...toolResponse, note: normalizedNote });
    }

    return JSON.stringify(toolResponse);
  }

  private async fetchExistingEscalations(
    chatId: string | undefined,
    bookingId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ExistingEscalation[]> {
    if (!chatId) {
      return [];
    }

    try {
      const baseUrl = process.env.ADMIN_INSTANCE_URL;
      const params = new URLSearchParams({ chatId });
      if (bookingId) {
        params.append('bookingId', bookingId);
      }
      const url = `${baseUrl}api/ai/escalations?${params.toString()}`;

      const httpsAgent = new https.Agent({ rejectUnauthorized: false });

      const response = await firstValueFrom(
        this.httpService.get(
          url,
          buildAdminRequestOptions({ httpsAgent, signal }),
        ),
      );

      const data = response.data as ExistingEscalationsResponse;
      return data.escalations ?? [];
    } catch (error) {
      Sentry.captureException(error);
      // If fetching fails, proceed with creating a new escalation (graceful degradation)
      return [];
    }
  }

  private async updateEscalation(
    escalationId: string,
    payload: EscalationUpdatePayload,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const baseUrl = process.env.ADMIN_INSTANCE_URL;
      const url = `${baseUrl}api/ai/escalations/${escalationId}`;
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });

      await firstValueFrom(
        this.httpService.put(
          url,
          payload,
          buildAdminRequestOptions({ httpsAgent, signal }),
        ),
      );

      return true;
    } catch (error) {
      Sentry.captureException(error);
      return false;
    }
  }

  /**
   * Compares two priorities. Returns > 0 if `a` is higher priority than `b`.
   * Priority 1 = HIGH, 2 = NORMAL, 3 = LOW. Lower number = higher priority.
   */
  private comparePriority(a: string, b: string): number {
    return Number(b) - Number(a);
  }

  /**
   * Elevates a priority by one level (3 -> 2, 2 -> 1, 1 stays 1).
   */
  private elevatePriority(priority: '1' | '2' | '3'): '1' | '2' | '3' {
    if (priority === '3') return '2';
    if (priority === '2') return '1';
    return '1';
  }

  private hasMeaningfulContextUpdate(
    existingSummary: string,
    newContext: string,
  ): boolean {
    // Normalize text so casing/spacing differences do not count as meaningful changes.
    const normalizedExistingSummary = this.normalizeText(existingSummary);
    const normalizedNewContext = this.normalizeText(newContext);

    if (!normalizedNewContext) {
      return false;
    }

    return !normalizedExistingSummary.includes(normalizedNewContext);
  }

  private normalizeText(value: string | undefined): string {
    if (!value) {
      return '';
    }

    return value.toLowerCase().replace(/\s+/g, ' ').trim();
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

// --- Similarity Checker Interface -------------------------------------------

export const SIMILARITY_PROMPT_TEMPLATE = `You are an issue similarity detector for a hospitality concierge system. Your job is to determine if a new guest complaint is about the same underlying issue as an existing escalation.

Compare the NEW issue with EACH existing escalation (guest issue + escalation summary) and determine if they refer to the same root problem.

Consider these as the SAME issue:
- Different phrasings of the same problem (e.g., "no hot water" vs "shower is ice cold")
- Follow-ups or updates about an already reported problem
- Related symptoms of the same root cause (e.g., "bathroom light flickering" and "electrical problem")

Consider these as DIFFERENT issues:
- Completely unrelated complaints (e.g., "no hot water" vs "Wi-Fi doesn't work")
- Issues in different areas/rooms unless clearly connected

NEW ISSUE: {newQuery}

EXISTING ESCALATIONS:
{existingEscalations}

Respond in valid JSON with the following structure:
{
  "isSimilar": boolean,
  "matchedEscalationId": string | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation"
}

If multiple escalations match, choose the most relevant one (prefer open over resolved, most recent over older).
Respond ONLY with the JSON object, no additional text.`;

export interface SimilarityChecker {
  checkSimilarity(
    newQuery: string,
    existingEscalations: ExistingEscalation[],
    options?: SimilarityCheckOptions,
  ): Promise<SimilarityResult>;
}

export interface SimilarityCheckOptions {
  // Used on retry when the first matched ID does not exist in fetched escalations.
  invalidMatchedEscalationId?: string;
}

/**
 * Formats existing escalations for inclusion in the similarity prompt.
 */
export function formatEscalationsForPrompt(
  escalations: ExistingEscalation[],
): string {
  return escalations
    .map(
      (e, i) =>
        `[${i + 1}] ID: ${e.id} | Status: ${e.status} | Priority: ${e.priority} | Issue: "${e.guestRequest}" | Summary: "${e.conciergeSummary}"`,
    )
    .join('\n');
}

// --- Interfaces -------------------------------------------------------------


export interface ExistingEscalation {
  id: string;
  guestRequest: string;
  conciergeSummary: string;
  status: 'open' | 'resolved' | string;
  priority: '1' | '2' | '3' | string;
  createdAt?: string;
}

export interface ExistingEscalationsResponse {
  escalations?: ExistingEscalation[];
}

export interface SimilarityResult {
  isSimilar: boolean;
  matchedEscalationId: string | null;
  confidence?: 'high' | 'medium' | 'low' | string;
  reasoning?: string;
}
interface ContactStaffToolResult {
  status: 'escalated';
  messageFromStaff: 'Not confirmed. Need to review.';
  note?: string;
}

interface EscalationUpdatedResult {
  status: 'updated';
  escalationId: string;
  message: string;
  priorityUpgraded?: boolean;
}

interface EscalationSkippedResult {
  status: 'skipped';
  escalationId: string;
  message: string;
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

interface EscalationUpdatePayload {
  conciergeSummary?: string;
  priority?: '1' | '2' | '3';
  guestRequest?: string;
}

