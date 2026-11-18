import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { subSignOff } from "../subSignOff.ts";

Deno.test("from-name equal to the org name signs as the org, not its first word", () => {
  assertEquals(subSignOff("The Ukulele Project", "The Ukulele Project"), "The Ukulele Project");
  assertEquals(subSignOff("Journey to STEAM", "journey to steam "), "Journey to STEAM");
});

Deno.test("a person's from-name signs as First @ Org", () => {
  assertEquals(subSignOff("Enrops", "Arielle Hammond"), "Arielle @ Enrops");
  assertEquals(subSignOff("Enrops", "  Arielle   Hammond "), "Arielle @ Enrops");
});

Deno.test("no from-name signs as the org", () => {
  assertEquals(subSignOff("Shoreview Chess", null), "Shoreview Chess");
  assertEquals(subSignOff("Shoreview Chess", "   "), "Shoreview Chess");
});

Deno.test("no org name never renders a dangling @", () => {
  assertEquals(subSignOff(null, "Arielle Hammond"), "Arielle");
  assertEquals(subSignOff("", null), "the team");
});
