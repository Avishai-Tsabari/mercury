import { describe, expect, test } from "bun:test";
import { applyRtlDirection } from "../src/text/rtl";

const RLM = "‏";
const RLE = "‫";
const LRE = "‪";

describe("applyRtlDirection", () => {
  test("returns empty string unchanged", () => {
    expect(applyRtlDirection("")).toBe("");
  });

  test("returns pure LTR byte-identical", () => {
    const input = "Hello world, this is a plain English message.";
    expect(applyRtlDirection(input)).toBe(input);
  });

  test("returns pure digits + punctuation byte-identical (no RTL strong char)", () => {
    const input = "1234 — 5678!";
    expect(applyRtlDirection(input)).toBe(input);
  });

  test("prefixes single-line Hebrew with one RLM", () => {
    expect(applyRtlDirection("שלום")).toBe(`${RLM}שלום`);
  });

  test("prefixes single-line Arabic with one RLM", () => {
    expect(applyRtlDirection("مرحبا")).toBe(`${RLM}مرحبا`);
  });

  test("detects mixed Hebrew + English and prefixes", () => {
    expect(applyRtlDirection("שלום John")).toBe(`${RLM}שלום John`);
  });

  test("prefixes every line in multi-line Hebrew", () => {
    const input = "שלום\nמה שלומך\nתודה";
    const expected = `${RLM}שלום\n${RLM}מה שלומך\n${RLM}תודה`;
    expect(applyRtlDirection(input)).toBe(expected);
  });

  test("prefixes empty lines too (harmless invisible)", () => {
    const input = "שלום\n\nתודה";
    const expected = `${RLM}שלום\n${RLM}\n${RLM}תודה`;
    expect(applyRtlDirection(input)).toBe(expected);
  });

  test("is idempotent: applying twice equals applying once", () => {
    const input = "שלום\nמה שלומך";
    const once = applyRtlDirection(input);
    const twice = applyRtlDirection(once);
    expect(twice).toBe(once);
  });

  test("collapses pre-existing N leading RLMs to exactly one", () => {
    const input = `${RLM}${RLM}${RLM}שלום`;
    expect(applyRtlDirection(input)).toBe(`${RLM}שלום`);
  });

  test("strips leading RLE (whatsapp-formatting skill pattern) before prefixing RLM", () => {
    const input = `${RLE}שלום John`;
    expect(applyRtlDirection(input)).toBe(`${RLM}שלום John`);
  });

  test("strips leading LRE before prefixing RLM", () => {
    const input = `${LRE}שלום`;
    expect(applyRtlDirection(input)).toBe(`${RLM}שלום`);
  });

  test("strips mixed leading bidi control run", () => {
    const input = `${RLE}${RLM}${LRE}שלום`;
    expect(applyRtlDirection(input)).toBe(`${RLM}שלום`);
  });

  test("leaves literal Hebrew letter prefix alone (user's old workaround)", () => {
    // "א" prepended by a prior LLM pass — not a bidi control, so we don't strip it.
    // RLM lands before the א; both render correctly.
    const input = "אשלום";
    expect(applyRtlDirection(input)).toBe(`${RLM}אשלום`);
  });

  test("does NOT prefix when text contains only LTR + bidi neutral chars", () => {
    // Stray RLM in an otherwise LTR string is treated as a strong RTL char by the
    // Bidi algorithm BUT is not in any of our Script categories — verify behavior.
    // (Script-property check: RLM (U+200F) has Script=Common, not any RTL script,
    // so HAS_RTL is false here.)
    const input = `hello ${RLM} world`;
    expect(applyRtlDirection(input)).toBe(input);
  });

  test("Syriac is detected", () => {
    expect(applyRtlDirection("ܫܠܡܐ")).toBe(`${RLM}ܫܠܡܐ`);
  });

  test("Thaana is detected", () => {
    expect(applyRtlDirection("ހެލޯ")).toBe(`${RLM}ހެލޯ`);
  });

  test("trailing newline preserved", () => {
    const input = "שלום\n";
    // split("\n") on "שלום\n" yields ["שלום", ""] → both get prefixed → joined.
    const expected = `${RLM}שלום\n${RLM}`;
    expect(applyRtlDirection(input)).toBe(expected);
  });

  test("very long Hebrew message is wrapped per line, no truncation", () => {
    const line = "שלום עולם".repeat(100);
    const input = `${line}\n${line}`;
    const result = applyRtlDirection(input);
    expect(result.startsWith(RLM)).toBe(true);
    expect(result.includes(`\n${RLM}`)).toBe(true);
    expect(result.split("\n").length).toBe(2);
  });
});
