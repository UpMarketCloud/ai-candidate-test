import { Injectable } from '@nestjs/common';
import { EscalatedAnswerDto } from '../../Dto/Slack/EscalatedAnswer.dto';

/**
 * Builds Slack block messages for escalation notifications.
 * This service is always mocked in tests — you don't need to modify it.
 */
@Injectable()
export class BuildEscalatedAnswerTemplate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(data: EscalatedAnswerDto): any {
    // Implementation uses slack-block-builder (not included in this repo).
    // In tests, mock this with: { execute: jest.fn().mockReturnValue('slack-blocks') }
    return data;
  }
}
