# Brief — landing-page hero scene (Unicorn Studio)

One animated WebGL scene behind the landing-page headline. You build it in Unicorn Studio;
it gets embedded into `landing.html` with a still-image fallback.

**Landing page only.** Never in the app (`index.html`): the app de-identifies patient scans
in the browser, and no third-party script may run on that page.

---

## 1. The idea: an uncertainty field

The product's whole pitch is that the AI shows *where it's unsure*. The hero should make
you feel that in two seconds without reading anything.

- **The base is an abstract OCT-like scan:** soft horizontal bands, gently curved, with a
  shallow dip in the middle (the fovea). Grainy, like OCT speckle. Calm, slow, almost still.
- **One warm hot spot:** a soft orange-amber glow sitting *on* the bands, off-centre to the
  right. It breathes slowly — this is "the model is unsure here".
- **The mouse moves the uncertainty:** where the cursor goes, the bands shimmer/distort
  slightly and a faint warm glow follows. Away from the cursor, everything settles back to
  calm. (Touch devices: the hot spot just drifts on its own.)

Calm everywhere, warm in one place = the **Review** outcome, which is the product's
signature. If you only manage the calm bands + one breathing hot spot, that's enough.

Reference for the look: the uncertainty map on the app's review screen (run `npm run dev`,
load the 12 sample scans, open any **Review** case).

## 2. Layout

| | Desktop | Mobile |
|---|---|---|
| Size | full width × **620 px** tall | full width × **520 px** tall |
| Text sits | left ~55% of the frame | bottom ~60% of the frame |
| Hot spot sits | right ~35%, vertically centred | top ~35%, centred |

- **Keep the text area dark and quiet.** White headline text goes on top of the left side; it
  must stay readable (contrast ≥ 4.5:1), so no bright glow or busy movement there.
- Design at 1600 × 620 and check it also crops well at 390 × 520 (phone).
- Edges should fade to the base colour so the scene blends into the page, no hard frame.

## 3. Colours — from the app, nothing else

| Role | Hex |
|---|---|
| Base / background | `#0A0F14` → `#13222E` (subtle vertical gradient) |
| Scan bands | `#B9C6D0` at 10–25% opacity, a few brighter lines up to ~40% |
| Cool accent (optional) | `#1A5FC8` at low opacity, for depth only |
| Hot spot core | `#C25200` |
| Hot spot glow | `#F0AA14` fading to transparent |

**No red, no green.** The app uses a blue–orange palette on purpose: users are eye-care
clinicians and ~8% of men have red–green colour deficiency. No neon, no rainbow gradients.

## 4. Motion rules

- **Slow.** A loop of roughly 12–20 seconds. It should read as breathing, not spinning.
- **No flashing.** Nothing brightens and darkens more than about 3 times per second
  (photosensitive-epilepsy guideline). Hot-spot pulses should be gentle and gradual.
- Mouse response is subtle. It should feel like disturbing water, not a laser pointer.
- The first frame should already look good; the page is mostly seen as a still.

## 5. Performance

Clinic front-desk PCs are often old, so:
- Keep layers and effects to the minimum that achieves the look.
- Test the preview on a normal laptop *on battery*. If it stutters, simplify.
- Target: smooth at 60 fps on an ordinary laptop; acceptable at 30 fps on older hardware.

## 6. Don'ts

- **No real patient scans or real OCT images** — not even de-identified. Abstract only.
- No eyeballs, no medical crosses, no stethoscopes, no "AI brain" imagery.
- No text inside the scene. All text stays in HTML so it's accessible and editable.
- No sound.

## 7. What to send back

1. The **embed code** or **project ID** from Unicorn Studio, with the scene *published*.
2. Two **still images** of the scene's first frame, for the fallback (shown when WebGL is
   unavailable, when the visitor prefers reduced motion, and while the scene loads):
   - `hero-desktop.png` — 1600 × 620
   - `hero-mobile.png` — 780 × 1040 (2× of 390 × 520)
3. If Unicorn Studio shows a **"made with" badge** on your plan, note it. We'll decide
   whether it's acceptable before going live.

Drop the images in `public/landing/` and paste the embed code in chat.

## 8. How it gets wired in

The hero container is already built into `landing.html` with a dark gradient standing in for
the scene. When the embed arrives:

- the scene loads after the page, and never blocks the text;
- if the visitor's system has *reduce motion* on, they get the still image, not the animation;
- if WebGL fails, the still image stays;
- the headline and form work fine with or without the scene.
