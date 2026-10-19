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
  // 공용 모니터 예약 카드는 일관된 블루 톤으로 표시한다.
  return {
    "--kiosk-booking-bg": "#e8eef8",
    "--kiosk-booking-border": "#b9cbe4",
    "--kiosk-booking-text": "#23466f",
    "--kiosk-booking-hover": "#dce7f5",
  };
}
