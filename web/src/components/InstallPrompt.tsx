import { useEffect, useState } from "react";
import { detectLanguage } from "../lib/languages";
import { strings } from "../lib/i18n";

/**
 * Invito all'installazione della PWA — "aggiungi alla schermata Home".
 *
 * Android/desktop (Chromium) espongono l'evento `beforeinstallprompt`: lo
 * catturiamo e mostriamo un pulsante nativo di installazione. iOS/Safari NON
 * lo espone: lì l'installazione è manuale (Condividi → Aggiungi a Home), quindi
 * mostriamo le istruzioni. In entrambi i casi il banner non compare se l'app è
 * già installata (avviata in modalità standalone) o è stato chiuso in sessione.
 *
 * Coerente con l'impianto stateless: nessun localStorage. La chiusura è
 * ricordata solo in `sessionStorage` (si azzera chiudendo la scheda).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "babyl-install-dismissed";

interface InstallStrings {
  title: string;
  body: string;
  iosBody: string;
  install: string;
  later: string;
}

// Stringhe locali del banner (compare a livello di app, prima del profilo:
// quindi la lingua è quella rilevata dal browser). Fallback all'inglese.
const INSTALL: Record<string, InstallStrings> = {
  it: {
    title: "Installa Babyl",
    body: "Aggiungila alla schermata Home: si apre come un'app, a tutto schermo.",
    iosBody: "Per installarla: tocca Condividi, poi «Aggiungi a Home».",
    install: "Installa",
    later: "Non ora",
  },
  en: {
    title: "Install Babyl",
    body: "Add it to your Home Screen: it opens like an app, full screen.",
    iosBody: "To install: tap Share, then “Add to Home Screen”.",
    install: "Install",
    later: "Not now",
  },
  de: {
    title: "Babyl installieren",
    body: "Zum Startbildschirm hinzufügen: öffnet sich wie eine App, im Vollbild.",
    iosBody: "Zum Installieren: auf Teilen tippen, dann „Zum Home-Bildschirm“.",
    install: "Installieren",
    later: "Nicht jetzt",
  },
  fr: {
    title: "Installer Babyl",
    body: "Ajoutez-la à l'écran d'accueil : elle s'ouvre comme une app, en plein écran.",
    iosBody: "Pour installer : touchez Partager, puis « Sur l'écran d'accueil ».",
    install: "Installer",
    later: "Plus tard",
  },
  es: {
    title: "Instalar Babyl",
    body: "Añádela a la pantalla de inicio: se abre como una app, a pantalla completa.",
    iosBody: "Para instalar: toca Compartir y luego «Añadir a inicio».",
    install: "Instalar",
    later: "Ahora no",
  },
  pt: {
    title: "Instalar o Babyl",
    body: "Adiciona-o ao ecrã principal: abre como uma app, em ecrã inteiro.",
    iosBody: "Para instalar: toca em Partilhar e depois «Adicionar ao ecrã principal».",
    install: "Instalar",
    later: "Agora não",
  },
  nl: {
    title: "Babyl installeren",
    body: "Voeg toe aan je startscherm: opent als een app, schermvullend.",
    iosBody: "Installeren: tik op Delen en dan ‘Zet op beginscherm’.",
    install: "Installeren",
    later: "Niet nu",
  },
  pl: {
    title: "Zainstaluj Babyl",
    body: "Dodaj do ekranu głównego: otwiera się jak aplikacja, na pełnym ekranie.",
    iosBody: "Aby zainstalować: dotknij Udostępnij, potem „Do ekranu początkowego”.",
    install: "Zainstaluj",
    later: "Nie teraz",
  },
  ru: {
    title: "Установить Babyl",
    body: "Добавьте на главный экран: откроется как приложение, во весь экран.",
    iosBody: "Чтобы установить: нажмите «Поделиться», затем «На экран „Домой“».",
    install: "Установить",
    later: "Не сейчас",
  },
  zh: {
    title: "安装 Babyl",
    body: "添加到主屏幕：像应用一样全屏打开。",
    iosBody: "安装方法：点按「分享」，然后选择「添加到主屏幕」。",
    install: "安装",
    later: "以后再说",
  },
  ja: {
    title: "Babyl をインストール",
    body: "ホーム画面に追加：アプリのように全画面で開きます。",
    iosBody: "インストール方法：共有をタップして「ホーム画面に追加」。",
    install: "インストール",
    later: "後で",
  },
  ko: {
    title: "Babyl 설치",
    body: "홈 화면에 추가하세요: 앱처럼 전체 화면으로 열립니다.",
    iosBody: "설치하려면: 공유를 누른 뒤 '홈 화면에 추가'를 선택하세요.",
    install: "설치",
    later: "나중에",
  },
  ar: {
    title: "تثبيت Babyl",
    body: "أضِفه إلى الشاشة الرئيسية: يُفتح كتطبيق بملء الشاشة.",
    iosBody: "للتثبيت: اضغط مشاركة ثم «إضافة إلى الشاشة الرئيسية».",
    install: "تثبيت",
    later: "ليس الآن",
  },
  hi: {
    title: "Babyl इंस्टॉल करें",
    body: "इसे होम स्क्रीन पर जोड़ें: यह किसी ऐप की तरह पूरी स्क्रीन पर खुलती है।",
    iosBody: "इंस्टॉल करने के लिए: शेयर पर टैप करें, फिर 'होम स्क्रीन में जोड़ें'।",
    install: "इंस्टॉल करें",
    later: "अभी नहीं",
  },
};

function installStrings(lang: string): InstallStrings {
  return INSTALL[lang] ?? INSTALL.en;
}

/** L'app è già installata / avviata come standalone? */
function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS espone navigator.standalone quando l'app è in home.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS Safari, dove l'installazione è manuale (nessun beforeinstallprompt). */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ si maschera da Mac: lo riconosciamo dal touch.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inSafari = /safari/i.test(ua) && !/crios|fxios|edgios|android/i.test(ua);
  return iOS && inSafari;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    if (sessionStorage.getItem(DISMISS_KEY)) return;

    // Android/desktop: l'evento arriva quando il browser ritiene l'app
    // installabile (manifest + service worker + criteri soddisfatti).
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // iOS: nessun evento — mostriamo le istruzioni dopo un attimo, così non
    // compaiono a schermata ancora vuota.
    let iosTimer: ReturnType<typeof setTimeout> | undefined;
    if (isIosSafari()) {
      iosTimer = setTimeout(() => {
        setIos(true);
        setVisible(true);
      }, 1200);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) clearTimeout(iosTimer);
    };
  }, []);

  if (!visible) return null;

  const lang = detectLanguage();
  const t = installStrings(lang);
  const dir = strings(lang).dir;

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => {});
    setDeferred(null);
    setVisible(false);
  };

  return (
    <div className="install-banner" role="dialog" aria-label={t.title} dir={dir}>
      <img className="install-icon" src="/icon-192.png" alt="" width={44} height={44} />
      <div className="install-text">
        <strong>{t.title}</strong>
        <span>{ios ? t.iosBody : t.body}</span>
      </div>
      <div className="install-actions">
        {!ios && deferred && (
          <button type="button" className="install-cta" onClick={install}>
            {t.install}
          </button>
        )}
        <button type="button" className="install-dismiss" onClick={dismiss}>
          {t.later}
        </button>
      </div>
    </div>
  );
}
