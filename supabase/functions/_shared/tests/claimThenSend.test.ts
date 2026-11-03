// Pins the claim -> send -> confirm/release order of the expiry email.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deliver } from "../claimThenSend.ts";

function steps(opts: { claimed: string[]; send: () => Promise<number> }) {
  const log: string[] = [];
  return {
    log,
    s: {
      claim: (items: string[]) => { log.push(`claim ${items.length}`); return Promise.resolve(opts.claimed); },
      send: (items: string[]) => { log.push(`send ${items.join(",")}`); return opts.send(); },
      confirm: (items: string[], n: number) => { log.push(`confirm ${items.length} ${n}`); return Promise.resolve(); },
      release: (items: string[]) => { log.push(`release ${items.length}`); return Promise.resolve(); },
    },
  };
}

Deno.test("claims before sending, sends only what it claimed, then confirms", async () => {
  const { log, s } = steps({ claimed: ["a"], send: () => Promise.resolve(2) });
  assertEquals(await deliver(["a", "b"], s), { status: "sent", items: 1, sent: 2 });
  assertEquals(log, ["claim 2", "send a", "confirm 1 2"]);
});

Deno.test("another run already claimed everything: nothing is sent", async () => {
  const { log, s } = steps({ claimed: [], send: () => Promise.resolve(1) });
  assertEquals(await deliver(["a"], s), { status: "already_claimed" });
  assertEquals(log, ["claim 1"]);
});

Deno.test("nobody reached: the claim is released for tomorrow", async () => {
  const { log, s } = steps({ claimed: ["a"], send: () => Promise.resolve(0) });
  assertEquals((await deliver(["a"], s)).status, "released");
  assertEquals(log, ["claim 1", "send a", "release 1"]);
});

Deno.test("sending throws: the claim is released, never stranded", async () => {
  const { log, s } = steps({ claimed: ["a"], send: () => Promise.reject(new Error("brand failed")) });
  assertEquals(await deliver(["a"], s), { status: "released", items: 1, reason: "brand failed" });
  assertEquals(log, ["claim 1", "send a", "release 1"]);
});
