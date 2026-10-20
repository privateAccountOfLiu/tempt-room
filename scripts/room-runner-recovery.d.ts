export interface RecoveryEntry {
  deliveryId: string;
  eventId: string;
  seq: number;
  text: string;
}
export function buildRecoveryPrompt(entries: readonly RecoveryEntry[]): {prompt: string; deliveryIds: string[]; maxSeq: number};
