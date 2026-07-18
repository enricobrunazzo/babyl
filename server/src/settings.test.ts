import test from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.ts";
import { Settings } from "./settings.ts";

test("settings: default d'ambiente senza DB, non persistono", () => {
  const s = new Settings(null, "interview");
  assert.deepEqual(s.get(), {
    defaultTiming: "interview",
    eventDefaultTiming: "interview",
  });
  // update senza DB non lancia e resta al default
  s.update({ defaultTiming: "streaming" });
  assert.equal(s.get().defaultTiming, "interview");
});

test("settings: aggiornamento persistito nel DB, con validazione", () => {
  const db = new Db(":memory:");
  const s = new Settings(db, "streaming");
  assert.equal(s.get().defaultTiming, "streaming");

  const updated = s.update({
    defaultTiming: "consecutive",
    eventDefaultTiming: "interview",
  });
  assert.equal(updated.defaultTiming, "consecutive");
  assert.equal(updated.eventDefaultTiming, "interview");

  // Un valore non valido ricade sul default; "release" è alias di consecutive.
  assert.equal(s.update({ defaultTiming: "boh" as never }).defaultTiming, "streaming");
  assert.equal(
    s.update({ defaultTiming: "release" as never }).defaultTiming,
    "consecutive",
  );

  // Sopravvive a una nuova istanza Settings sullo stesso DB.
  const s2 = new Settings(db, "streaming");
  assert.equal(s2.get().eventDefaultTiming, "interview");
  db.close();
});
