/** Display-only name colours for the shared monitor, never an identity/permission key.
 * No assignment table or personal data is stored in the browser. The same name
 * stays the same colour across rooms, weeks, refreshes and reservation status.
 * Shared/identical names share a colour; colours are not unique person IDs.
 */
export function kioskBookingColors(owner: string) {
  const name = owner.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  let hash = 2166136261;
  for (const character of name) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  const hue = hash % 359;
  const saturation = 50 + (hash >>> 16) % 12;
  return {
    "--kiosk-booking-bg": `hsl(${hue} ${saturation}% 95%)`,
    "--kiosk-booking-border": `hsl(${hue} 36% 77%)`,
    "--kiosk-booking-text": `hsl(${hue} 50% 25%)`,
    "--kiosk-booking-hover": `hsl(${hue} ${saturation}% 91%)`,
  };
}
