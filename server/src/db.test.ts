import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

test("migrazioni: schema alla versione corrente su DB nuovo", () => {
  const db = new Db(":memory:");
  assert.equal(db.schemaVersion(), 1);
  db.close();
});

test("organizzatore: crea, rilegge per id e per email; email unica", () => {
  const db = new Db(":memory:");
  const o = db.createOrganizer("enrico@babyl.app", 3600);
  assert.equal(o.email, "enrico@babyl.app");
  assert.equal(o.creditsSeconds, 3600);
  assert.equal(o.stripeCustomerId, null);
  assert.deepEqual(db.getOrganizer(o.id), o);
  assert.deepEqual(db.getOrganizerByEmail("enrico@babyl.app"), o);
  assert.equal(db.getOrganizerByEmail("ignoto@x.it"), null);
  assert.throws(() => db.createOrganizer("enrico@babyl.app"));
  db.close();
});

test("crediti: ricarica e consumo transazionale senza andare sotto zero", () => {
  const db = new Db(":memory:");
  const o = db.createOrganizer("a@b.it", 100);
  assert.equal(db.addCredits(o.id, 50), 150);
  assert.equal(db.consumeCredits(o.id, 60), 60);
  assert.equal(db.getOrganizer(o.id)?.creditsSeconds, 90);
  // Chiede più del residuo: scala solo ciò che c'è, mai negativo.
  assert.equal(db.consumeCredits(o.id, 999), 90);
  assert.equal(db.getOrganizer(o.id)?.creditsSeconds, 0);
  assert.equal(db.consumeCredits(o.id, 10), 0);
  db.close();
});

test("evento: crea, rilegge per slug, lingue round-trip, slug unico", () => {
  const db = new Db(":memory:");
  const o = db.createOrganizer("org@evt.it");
  const e = db.createEvent({
    slug: "piazza",
    organizerId: o.id,
    title: "Evento · Piazza",
    listenLangs: ["it", "en", "de"],
    timing: "streaming",
    scheduledAt: 1_800_000_000_000,
  });
  assert.equal(e.slug, "piazza");
  assert.equal(e.status, "scheduled");
  assert.deepEqual(e.listenLangs, ["it", "en", "de"]);
  assert.deepEqual(db.getEventBySlug("piazza"), e);
  assert.equal(db.getEventBySlug("inesistente"), null);
  assert.throws(() =>
    db.createEvent({
      slug: "piazza",
      organizerId: o.id,
      title: "Doppione",
      listenLangs: ["it"],
      timing: "streaming",
    }),
  );
  db.close();
});

test("evento: FK sull'organizzatore inesistente rifiutata", () => {
  const db = new Db(":memory:");
  assert.throws(() =>
    db.createEvent({
      slug: "orfano",
      organizerId: 999,
      title: "Senza organizzatore",
      listenLangs: ["it"],
      timing: "streaming",
    }),
  );
  db.close();
});

test("evento: cambio stato e lista per organizzatore ordinata", () => {
  const db = new Db(":memory:");
  const o = db.createOrganizer("org@list.it");
  const a = db.createEvent({
    slug: "a",
    organizerId: o.id,
    title: "A",
    listenLangs: ["it"],
    timing: "streaming",
    scheduledAt: 1000,
  });
  const b = db.createEvent({
    slug: "b",
    organizerId: o.id,
    title: "B",
    listenLangs: ["it"],
    timing: "streaming",
    scheduledAt: 2000,
  });
  db.setEventStatus(a.id, "ended");
  assert.equal(db.getEvent(a.id)?.status, "ended");
  // Ordine per data prevista decrescente: b (2000) prima di a (1000).
  const list = db.listEventsByOrganizer(o.id);
  assert.deepEqual(
    list.map((e) => e.slug),
    ["b", "a"],
  );
  db.close();
});

test("persistenza: i dati sopravvivono alla riapertura del file", () => {
  const dir = mkdtempSync(join(tmpdir(), "babyl-db-"));
  const path = join(dir, "test.db");
  try {
    const db1 = new Db(path);
    const o = db1.createOrganizer("persist@x.it", 42);
    db1.createEvent({
      slug: "persistente",
      organizerId: o.id,
      title: "Persistente",
      listenLangs: ["it", "fr"],
      timing: "interview",
    });
    db1.close();

    const db2 = new Db(path);
    assert.equal(db2.schemaVersion(), 1);
    assert.equal(db2.getOrganizerByEmail("persist@x.it")?.creditsSeconds, 42);
    assert.deepEqual(db2.getEventBySlug("persistente")?.listenLangs, ["it", "fr"]);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
