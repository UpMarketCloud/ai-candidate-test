import {ConversationDto} from "./conversation.dto";

export class AskQuestionDto {
    question: string;
    additionalInstruction: string | undefined;
    locationId: string | undefined;
    hostId: string;
    bookingId: string | undefined;
    bookingStatus: string | undefined;
    unitTypeId: string | undefined;
    chatId: string | undefined;
    chatMessageId: string | undefined;
    language: string | undefined;
    hostLanguage: string;
    timezone: string | undefined;

    history: ConversationDto[] | string | undefined;
    scope: string;
    source: string | undefined;
}
