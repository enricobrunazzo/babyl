import test from "node:test";
import assert from "node:assert/strict";
import { SegmentDedup, normalizeTranscript } from "./dedup.ts";

test("normalizeTranscript: minuscolo, spazi e punteggiatura di contorno", () => {
  assert.equal(normalizeTranscript("App testing session."), "app testing session");
  assert.equal(normalizeTranscript("  App   testing\tsession  "), "app testing session");
  assert.equal(normalizeTranscript("«Ciao!»"), "ciao");
  assert.equal(normalizeTranscript("...."), "");
});

test("dedup: primo segmento sempre keep, senza baseline", () => {
  const d = new SegmentDedup(4000, () => 1000);
  assert.equal(d.begin(), "keep");
  assert.equal(d.evaluate("App testing", false), "keep");
});

test("dedup: doppione consecutivo entro la finestra viene scartato", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);

  // Primo segmento: keep, poi diventa baseline.
  assert.equal(d.begin(), "keep");
  d.commitKept("App testing session.");

  // Secondo segmento, 300 ms dopo, identico: parte pending e finisce drop.
  now = 1300;
  assert.equal(d.begin(), "pending");
  assert.equal(d.evaluate("App testing", false), "pending");
  assert.equal(d.evaluate("App testing session", false), "pending");
  assert.equal(d.evaluate("App testing session.", true), "drop");
});

test("dedup: segmento nuovo che diverge presto torna keep (bassa latenza)", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  d.commitKept("App testing session.");

  now = 1300;
  assert.equal(d.begin(), "pending");
  // "app" è ancora prefisso della baseline → indeciso...
  assert.equal(d.evaluate("App", false), "pending");
  // ...ma appena diverge ("apple") è un segmento nuovo da emettere subito.
  assert.equal(d.evaluate("Apple pie", false), "keep");
});

test("dedup: un segmento che estende il precedente non è un doppione", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  d.commitKept("App testing session.");

  now = 1300;
  assert.equal(d.begin(), "pending");
  assert.equal(
    d.evaluate("App testing session is starting now.", true),
    "keep",
  );
});

test("dedup: ripetizione voluta oltre la finestra viene mantenuta", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  d.commitKept("Grazie a tutti.");

  // Stessa frase ma 5 s dopo: pausa = ripetizione voluta, non loop.
  now = 6000;
  assert.equal(d.begin(), "keep");
  assert.equal(d.evaluate("Grazie a tutti.", true), "keep");
});

test("dedup: reset (cambio parlante) sblocca la stessa frase da un altro", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  d.commitKept("Buongiorno.");

  now = 1200;
  d.reset();
  // Altro parlante, stessa frase, subito dopo: legittima.
  assert.equal(d.begin(), "keep");
  assert.equal(d.evaluate("Buongiorno.", true), "keep");
});

test("dedup: loop a raffica, solo la prima occorrenza sopravvive", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  const kept: string[] = [];

  const segment = (transcript: string, gapMs: number) => {
    const initial = d.begin();
    const decision = initial === "keep" ? "keep" : d.evaluate(transcript, true);
    if (decision === "keep") {
      kept.push(transcript);
      d.commitKept(transcript);
    } else {
      d.touch();
    }
    now += gapMs;
  };

  // 30 doppioni back-to-back per 15 s totali (ben oltre la finestra di 4 s):
  // touch() prolunga la soppressione finché i doppioni restano fitti.
  segment("App testing session.", 500);
  for (let i = 0; i < 30; i++) segment("App testing session.", 500);

  assert.deepEqual(kept, ["App testing session."]);
});

test("dedup: dopo una pausa lunga il loop si interrompe e la frase riparte", () => {
  let now = 1000;
  const d = new SegmentDedup(4000, () => now);
  const kept: string[] = [];

  const segment = (transcript: string, gapMs: number) => {
    const decision = d.begin() === "keep" ? "keep" : d.evaluate(transcript, true);
    if (decision === "keep") {
      kept.push(transcript);
      d.commitKept(transcript);
    } else {
      d.touch();
    }
    now += gapMs;
  };

  segment("Grazie.", 300);
  segment("Grazie.", 5000); // scartato, ma poi 5 s di silenzio
  segment("Grazie.", 300); // ripetizione voluta dopo la pausa: mantenuta

  assert.deepEqual(kept, ["Grazie.", "Grazie."]);
});
