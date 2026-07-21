import { BabylMark } from "./BabylLogo";
import {
  HandIcon,
  HeadphonesIcon,
  LockIcon,
  MicIcon,
  RoomIcon,
  SpeakerWaveIcon,
} from "./icons";

/**
 * Manuale d'uso (rotta `/manuale`): guida sintetica e coerente col brand su
 * come funziona babyl — modalità, microfono, eventi. Desktop-responsive.
 */
export function Manuale() {
  return (
    <main className="man">
      <header className="man-hero">
        <BabylMark size={52} />
        <h1>Manuale</h1>
        <p>
          Traduzione simultanea dal vivo. Zero download, zero account: il link è
          la stanza.
        </p>
      </header>

      <nav className="man-toc" aria-label="Indice">
        <a href="#modalita">Modalità</a>
        <a href="#microfono">Il microfono</a>
        <a href="#evento">Eventi</a>
        <a href="#creare">Creare un evento</a>
        <a href="#lingue">Lingue</a>
        <a href="#principio">Il principio</a>
      </nav>

      <section className="man-sec" id="modalita">
        <span className="man-eyebrow">01 · Come si usa</span>
        <h2>Tre modalità</h2>
        <p className="man-lead">
          Scegli come parlarti addosso al mondo: a distanza, faccia a faccia, o
          davanti a una platea.
        </p>
        <div className="man-cards">
          <article className="man-card">
            <RoomIcon size={22} />
            <h3>Stanza</h3>
            <p>
              Più dispositivi nella stessa conversazione: ognuno ascolta nella
              propria lingua. Il link (o il QR) è la stanza.
            </p>
          </article>
          <article className="man-card">
            <SpeakerWaveIcon size={22} />
            <h3>Un solo dispositivo</h3>
            <p>
              Faccia a faccia con un solo telefono in mezzo: due lingue, si passa
              la parola toccando il microfono della lingua giusta.
            </p>
          </article>
          <article className="man-card">
            <HeadphonesIcon size={22} />
            <h3>Evento</h3>
            <p>
              Un relatore parla, tutta la platea ascolta tradotta nella propria
              lingua. Con richieste d'intervento (alza la mano).
            </p>
          </article>
        </div>
      </section>

      <section className="man-sec" id="microfono">
        <span className="man-eyebrow">02 · Parlare</span>
        <h2>Il microfono</h2>
        <p className="man-lead">
          Il canale è a mani alterne (half-duplex): parla una persona alla volta,
          così le voci non si accavallano e la traduzione resta pulita.
        </p>
        <ul className="man-steps">
          <li>
            <span className="man-ico"><MicIcon size={18} /></span>
            <div>
              <b>Premi e tieni premuto</b> il microfono per parlare. Al rilascio
              il canale si libera.
            </div>
          </li>
          <li>
            <span className="man-ico"><LockIcon size={18} /></span>
            <div>
              <b>Scorri verso destra</b> fino al lucchetto per bloccare il
              microfono a mani libere: utile per interventi lunghi.
            </div>
          </li>
          <li>
            <span className="man-ico"><LockIcon size={18} /></span>
            <div>
              Quando è bloccato, l'icona diventa rossa: <b>tocca</b> una volta per
              fermare.
            </div>
          </li>
        </ul>
        <p className="man-note">
          Un breve segnale acustico avvisa quando il microfono è pronto (es. dopo
          che ti viene concessa la parola in un evento).
        </p>
      </section>

      <section className="man-sec" id="evento">
        <span className="man-eyebrow">03 · Conferenze</span>
        <h2>Modalità evento</h2>
        <div className="man-roles">
          <article className="man-card">
            <MicIcon size={22} />
            <h3>Relatore</h3>
            <p>
              Parli dal microfono dell'app; tutti ti ricevono tradotto. Vedi le
              richieste d'intervento e concedi (o ritiri) la parola.
            </p>
          </article>
          <article className="man-card">
            <HandIcon size={22} />
            <h3>Pubblico</h3>
            <p>
              Entri dal link/QR come ascoltatore, microfono spento. Alzi la mano
              per chiedere la parola; quando te la danno, parli nella tua lingua e
              arrivi tradotto a tutti.
            </p>
          </article>
        </div>
        <p className="man-note">
          <HeadphonesIcon size={15} /> In un evento gli <b>auricolari sono
          consigliati</b>: evitano fischi e rientri quando l'audio tradotto
          uscirebbe dagli altoparlanti in sala.
        </p>
      </section>

      <section className="man-sec" id="creare">
        <span className="man-eyebrow">04 · Organizzatore</span>
        <h2>Creare un evento</h2>
        <ol className="man-ol">
          <li>
            Apri <code>/organizer</code> e inserisci il token.
          </li>
          <li>
            Compila <b>Nuovo evento</b>: titolo, lingue d'ascolto, tempistica,
            data. Ottieni uno slug (il link stabile).
          </li>
          <li>
            <b>▶ Avvia come relatore</b> per entrare tu e parlare.
          </li>
          <li>
            Condividi il <b>link/QR per il pubblico</b>: chi lo apre sceglie la
            propria lingua e ascolta.
          </li>
        </ol>
        <p className="man-note">
          La stanza dell'evento parte già con la tempistica scelta: non serve
          reimpostare nulla.
        </p>
      </section>

      <section className="man-sec" id="lingue">
        <span className="man-eyebrow">05 · Lingue</span>
        <h2>La tua lingua, sempre</h2>
        <p className="man-lead">
          L'interfaccia e la traduzione seguono la lingua che scegli. La puoi
          cambiare a caldo dalla stanza; per l'arabo il testo passa da destra a
          sinistra. Sono supportate 15 lingue.
        </p>
      </section>

      <section className="man-sec man-principle" id="principio">
        <span className="man-eyebrow">Il principio</span>
        <h2>Traduce. Non interpreta.</h2>
        <p className="man-lead">
          babyl rende <b>fedelmente</b> quello che dici — vicino alle parole
          originali quanto la grammatica d'arrivo consente. Non spiega, non
          parafrasa, non riassume, non aggiunge. Una voce, la tua, in un'altra
          lingua.
        </p>
      </section>

      <footer className="man-footer">
        <BabylMark size={26} />
        <span>babyl · traduzione simultanea</span>
      </footer>
    </main>
  );
}
