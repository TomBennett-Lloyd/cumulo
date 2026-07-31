import { z } from 'zod';

/**
 * A credit that must be rendered wherever the data it accompanies is displayed.
 *
 * Text and link together, because an attribution that reaches the UI as a bare
 * string is an attribution the UI has to invent a URL for — and CC BY 4.0 asks
 * for the link, not just the name.
 */
export const attributionSchema = z.object({
  text: z.string().min(1),
  url: z.url(),
});

export type Attribution = z.infer<typeof attributionSchema>;

/**
 * The Open-Meteo credit, in the exact wording the project is committed to.
 *
 * Open-Meteo's data is CC BY 4.0 and attribution is a hard constraint in
 * `CLAUDE.md`: a visible "Weather data by Open-Meteo.com" link wherever
 * weather-derived data is displayed. Defining it once, here, is what makes that
 * a property of the shared contract rather than of each surface remembering:
 * the Fleet API embeds this object in every weather-derived response body, and
 * the web app renders it rather than hard-coding its own copy.
 *
 * Parsed rather than asserted, so the literal is checked against
 * {@link attributionSchema} at module load — a typo in the URL fails on import,
 * not in front of a reviewer.
 */
export const openMeteoAttribution: Attribution = attributionSchema.parse({
  text: 'Weather data by Open-Meteo.com',
  url: 'https://open-meteo.com/',
});
