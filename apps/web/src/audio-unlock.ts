/**
 * Keeping Safari's permission to make a sound.
 *
 * THE PROBLEM, precisely. iOS Safari only lets an `<audio>` element play if
 * `play()` is called while a user activation is in effect. Activation survives
 * synchronous code and microtasks, but NOT a real await on network I/O — and the
 * pronunciation chain does exactly that: probe the local service, probe the
 * device voice, POST to `/api/tts`, wait for MP3 bytes. By the time an element
 * could be constructed and played, the activation is long gone and Safari
 * rejects playback with `NotAllowedError`. The learner taps, nothing happens,
 * and nothing in the console explains it.
 *
 * THE FIX. Claim the permission at the only moment it exists — synchronously,
 * inside the tap handler — by creating one `<audio>` element and calling
 * `play()` on a silent inline clip. That call is inside the gesture, so it is
 * allowed; once the element has played once it stays unlocked, and its `src` can
 * be swapped later for the real audio and played again with no activation.
 *
 * So the element is created first and filled in afterwards, which is the reverse
 * of the obvious order and the reason this file exists.
 *
 * ONE ELEMENT, REUSED. A fresh element per word would need unlocking every time,
 * and on iOS a second element created outside a gesture is not unlocked at all.
 * Reusing one also means a new word implicitly stops the previous one, which is
 * the behaviour a learner expects anyway.
 *
 * This is a no-op cost on every other platform: one muted play of 0.05s of
 * silence, which Chrome and Firefox allow regardless.
 */

/**
 * A minimal silent MP3 frame as a data URI.
 *
 * Inline rather than a file so unlocking needs no network — the whole point is
 * that it happens instantly, inside the gesture, before anything is fetched.
 */
const SILENCE =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA"
  + "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP///////////////////////////"
  + "//////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAA"
  + "AAAAAnGMU3WWAAAAAAAAAAAAAAAAAAAA";

let unlocked: HTMLAudioElement | undefined;

/**
 * Claim playback permission. MUST be called synchronously from a user gesture.
 *
 * Returns the element the providers will play through. Safe to call on every
 * tap: after the first success it simply hands the same element back.
 */
export function unlockAudio(): HTMLAudioElement | undefined {
  if (typeof Audio === "undefined") return undefined;

  if (!unlocked) {
    const element = new Audio();
    element.preload = "auto";
    // Some iOS versions require the element to be in the document before it will
    // hold its unlocked state across an src change.
    element.setAttribute("playsinline", "");
    unlocked = element;
  }

  // Only prime when idle. Interrupting a clip that is genuinely playing would
  // cut off the word the learner is listening to.
  if (unlocked.paused) {
    const previous = unlocked.src;
    if (!previous || previous.startsWith("data:")) {
      unlocked.src = SILENCE;
      unlocked.muted = true;
      // Deliberately not awaited: awaiting would push the rest of the handler
      // past the activation window, which is the exact bug this avoids. A
      // rejection is fine — it means this platform did not need unlocking.
      void unlocked.play().catch(() => undefined);
    }
  }

  return unlocked;
}

/**
 * Point the unlocked element at real audio and play it.
 *
 * Unmutes first: the element was muted to make the silent prime inaudible, and a
 * muted element plays a word to nobody.
 */
export async function playThrough(element: HTMLAudioElement, src: string, speed: number): Promise<void> {
  element.pause();
  element.muted = false;
  element.src = src;
  element.playbackRate = speed;
  element.currentTime = 0;

  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("playback failed")); };
    const cleanup = () => {
      element.removeEventListener("ended", done);
      element.removeEventListener("error", failed);
    };
    element.addEventListener("ended", done);
    element.addEventListener("error", failed);
    element.play().catch((error) => { cleanup(); reject(error as Error); });
  });
}

/** Forget the unlocked element — tests only; a page has exactly one. */
export function resetAudioUnlock(): void {
  unlocked = undefined;
}
