export class EscalatedAnswerDto {
  hostId: string | undefined;
  bookingId: string | undefined;
  question: string;
  answer: string;
  evaluation: string;
  locationId: string | undefined;
  chatId: string | undefined;
  chatMessageId: string | undefined;
  priority: '1' | '2' | '3';
}
