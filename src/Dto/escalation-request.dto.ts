export class EscalationRequestDto {
  guestRequest: string;
  conciergeSummary: string;
  bookingId: string | undefined;
  chatId: string | undefined;
  hostId: string | undefined;
  locationId: string | undefined;
  priority: '1' | '2' | '3';
  chatMessageId: string | undefined;
}
