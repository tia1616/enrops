import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { advertisedPriceLabel, advertisedPriceRangeLabel } from "../advertisedPrice.ts";

const passThrough = {
  fee_pass_through: true, platform_fee_card_pct: 0.03, platform_fee_ach_pct: 0.02,
  platform_fee_floor_cents: 199, platform_fee_cap_cents: 1499,
} as never;

Deno.test("pass-through range is all-in on both ends", () => {
  assertEquals(advertisedPriceRangeLabel([28500, 29900], passThrough), `${advertisedPriceLabel(28500, passThrough)} to ${advertisedPriceLabel(29900, passThrough)}`);
});

Deno.test("same prices render exactly as the single-program label", () => {
  assertEquals(advertisedPriceRangeLabel([28500, 28500], null), advertisedPriceLabel(28500, null));
  assertEquals(advertisedPriceRangeLabel([28500], passThrough), advertisedPriceLabel(28500, passThrough));
});

Deno.test("different prices render low to high, order-independent", () => {
  assertEquals(advertisedPriceRangeLabel([29900, 28500], null), "$285 to $299");
});

Deno.test("missing and zero prices are ignored; none is empty", () => {
  assertEquals(advertisedPriceRangeLabel([null, 0, 28500], null), "$285");
  assertEquals(advertisedPriceRangeLabel([null, undefined], null), "");
});
