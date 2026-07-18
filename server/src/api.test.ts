import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.ts";
import { createEventForOrganizer, parseTiming, slugify } from "./api.ts";

test("slugify: minuscole, senza accenti, trattini", () => {
  assert.equal(slugify("Evento · Piàzza!"), "evento-piazza");
  assert.equal(slugify("  Hello   World  "), "hello-world");
  assert.equal(slugify("città-Öl_2025"), "citta-ol-2025");
});

test("parseTiming: valida e usa alias/default", () => {
  assert.equal(parseTiming("interview"), "interview");
  assert.equal(parseTiming("release"), "consecutive");
  assert.equal(parseTiming("boh"), "streaming");
  assert.equal(parseTiming(undefined), "streaming");
});

test("createEvent: crea organizzatore al volo e slug dal titolo", () => {
  const db = new Db(":memory:");
  const ev = createEventForOrganizer(db, {
    organizerEmail: "Enrico@Babyl.app",
    title: "Evento · Piazza",
    listenLangs: ["it", "en"],
    timing: "streaming",
  });
  assert.equal(ev.slug, "evento-piazza");
  assert.equal(ev.status, "scheduled");
  // Email normalizzata a minuscolo, organizzatore riusato al secondo evento.
  const org = db.getOrganizerByEmail("enrico@babyl.app");
  assert.ok(org);
  assert.deepEqual(ev.listenLangs, ["it", "en"]);
  db.close();
});

test("createEvent: slug in collisione riceve un suffisso univoco", () => {
  const db = new Db(":memory:");
  const a = createEventForOrganizer(db, {
    organizerEmail: "o@x.it",
    title: "Piazza",
    listenLangs: ["it"],
  });
  const b = createEventForOrganizer(db, {
    organizerEmail: "o@x.it",
    title: "Piazza",
    listenLangs: ["it"],
  });
  assert.equal(a.slug, "piazza");
  assert.notEqual(b.slug, a.slug);
  assert.match(b.slug, /^piazza-[a-z0-9]{4}$/);
  // Stesso organizzatore riusato (nessun doppione).
  assert.equal(a.organizerId, b.organizerId);
  db.close();
});

test("createEvent: input non validi rifiutati con status", () => {
  const db = new Db(":memory:");
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ organizerEmail: "no-at", title: "T", listenLangs: ["it"] }, 400],
    [{ organizerEmail: "a@b.it", title: "", listenLangs: ["it"] }, 400],
    [{ organizerEmail: "a@b.it", title: "T", listenLangs: [] }, 400],
  ];
  for (const [input, status] of cases) {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => createEventForOrganizer(db, input as any),
      (err: Error & { status?: number }) => err.status === status,
    );
  }
  db.close();
});
