// Claim, then send, then confirm or release - the order that keeps an expiry
// notice from going out twice (two overlapping runs) or never (a run that dies
// after claiming). Pure orchestration over injected steps so the order is
// tested without a database or Resend.

export interface DeliverSteps<T> {
  /** Insert ledger rows; return only the items THIS call inserted. */
  claim: (items: T[]) => Promise<T[]>;
  /** Email the claimed items; return how many recipients got it. */
  send: (items: T[]) => Promise<number>;
  /** Record how many recipients got it. */
  confirm: (items: T[], sent: number) => Promise<void>;
  /** Remove the claim so the next run tries again. */
  release: (items: T[]) => Promise<void>;
}

export type DeliverResult =
  | { status: "already_claimed" }
  | { status: "sent"; items: number; sent: number }
  | { status: "released"; items: number; reason: string };

export async function deliver<T>(items: T[], steps: DeliverSteps<T>): Promise<DeliverResult> {
  const mine = await steps.claim(items);
  if (mine.length === 0) return { status: "already_claimed" };
  let sent = 0;
  try {
    sent = await steps.send(mine);
  } catch (e) {
    await steps.release(mine);
    return { status: "released", items: mine.length, reason: (e as Error).message };
  }
  if (sent === 0) {
    await steps.release(mine);
    return { status: "released", items: mine.length, reason: "no recipient could be emailed" };
  }
  await steps.confirm(mine, sent);
  return { status: "sent", items: mine.length, sent };
}
