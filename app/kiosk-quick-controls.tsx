import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FavoriteButton, FavoriteIcon, useFavorites } from "./convenience";
import { formatCapacity, floors, rooms, type Room } from "./lib/rooms";

type RoomPickerProps = {
  selected: Room;
  disabled: boolean;
  onSelect: (room: Room) => void;
};

export function KioskRoomPicker({ selected, disabled, onSelect }: RoomPickerProps) {
  const favorites = useFavorites(null, true);
  const [open, setOpen] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [locationRoom, setLocationRoom] = useState<Room | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices = useMemo(() => favoritesOnly ? rooms.filter(room => favorites.ids.includes(room.id)) : rooms, [favorites.ids, favoritesOnly]);

  useEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const top = Math.min(box.bottom + 6, Math.max(8, window.innerHeight - 360));
      const maxHeight = Math.max(180, window.innerHeight - top - 10);
      setPosition({ position: "fixed", top, left: Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8)), width: box.width, maxHeight, zIndex: 100 });
    };
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frame); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key);
    };
  }, [open]);

  const choose = (room: Room) => { onSelect(room); setOpen(false); setFavoritesOnly(false); };
  return <div className="kiosk-room-picker-shell" ref={root}>
    <section className="room-picker-card kiosk-room-picker-card" aria-label="회의실 선택">
      <button ref={trigger} type="button" data-testid="kiosk-room" data-selected-room={selected.id} className={`room-picker-toggle ${open ? "open" : ""}`} aria-label={`회의실 선택: ${selected.name} ${selected.floor}층`} aria-expanded={open} disabled={disabled}
        onClick={() => setOpen(value => !value)}>
        <span className="room-picker-field-copy">
          <span className="room-picker-field-title"><span className="status-dot available" /><strong>{selected.name}</strong><small className="room-picker-field-floor">{selected.floor}F</small></span>
          <span className="room-picker-field-specs"><em>{formatCapacity(selected.capacity)}</em>{selected.equipment.slice(0, 2).map(item => <em key={item}>{item}</em>)}</span>
        </span><i aria-hidden="true" />
      </button>
      {open && <div className="room-picker-options room-picker-popover kiosk-room-picker-popover" role="dialog" aria-label="회의실 선택" style={position} onPointerDown={event => event.stopPropagation()}>
        <div className="room-picker-filters" role="group" aria-label="회의실 목록 필터">
          <button type="button" aria-pressed={!favoritesOnly} onClick={() => setFavoritesOnly(false)}>전체 회의실</button>
          <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(true)}><FavoriteIcon />즐겨찾기{!!favorites.ids.length && <span className="favorite-count">{favorites.ids.length}</span>}</button>
        </div>
        {favorites.message && <p className="favorites-hint" role="status">{favorites.message}</p>}
        {favoritesOnly && !choices.length && <div className="room-picker-empty"><FavoriteIcon /><strong>즐겨찾는 회의실이 없어요</strong><p>전체 목록에서 별을 눌러 추가하세요.</p><button type="button" onClick={() => setFavoritesOnly(false)}>전체 회의실 보기</button></div>}
        {floors.filter(level => choices.some(room => room.floor === level)).map(level => <div className="room-picker-floor-group" key={level}>
          <small>{level}F</small>
          {choices.filter(room => room.floor === level).map(room => <div className="room-picker-row" data-room={room.id} key={room.id}>
            <button type="button" className={selected.id === room.id ? "selected" : ""} title={`${room.floor}층 · ${room.name} · ${formatCapacity(room.capacity)} · ${room.equipment.join(" · ")}`} onClick={() => choose(room)}>
              <span className="room-picker-name"><span className="status-dot available" /><strong>{room.name}</strong></span>
              <em>{formatCapacity(room.capacity)} · {room.equipment.slice(0, 2).join(" · ")}</em>
            </button>
            <FavoriteButton roomId={room.id} active={favorites.ids.includes(room.id)} disabled={!favorites.loaded || favorites.pending.includes(room.id)} onClick={() => void favorites.toggle(room.id)} />
            <button type="button" className="room-picker-row-map" title={`${room.name} 위치 보기`} aria-label={`${room.name} 위치 보기`} onClick={() => setLocationRoom(room)}><PinIcon /></button>
          </div>)}
        </div>)}
      </div>}
    </section>
    {locationRoom && <div className="kiosk-location-backdrop" role="presentation" onMouseDown={() => setLocationRoom(null)}>
      <section className="kiosk-location-dialog" role="dialog" aria-modal="true" aria-label={`${locationRoom.name} 위치`} onMouseDown={event => event.stopPropagation()}>
        <button type="button" className="kiosk-location-close" aria-label="닫기" onClick={() => setLocationRoom(null)}>×</button>
        <PinIcon /><strong>{locationRoom.floor}F · {locationRoom.name}</strong><p>{locationRoom.location}</p>
      </section>
    </div>}
  </div>;
}

function PinIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
}

type TimePickerProps = {
  start: string;
  end: string;
  startOptions: string[];
  endOptions: string[];
  disabled: boolean;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
};

export function KioskTimePicker({ start, end, startOptions, endOptions, disabled, onStart, onEnd }: TimePickerProps) {
  const [open, setOpen] = useState<"start" | "end" | null>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const endButton = useRef<HTMLButtonElement>(null);
  const options = open === "start" ? startOptions : endOptions;

  useEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const place = () => {
      const anchor = (open === "start" ? startButton.current : endButton.current)?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(root.current?.getBoundingClientRect().width ?? 340, window.innerWidth - 16);
      const estimatedHeight = Math.min(290, 54 + Math.ceil(options.length / 4) * 44 + 18);
      const below = window.innerHeight - anchor.bottom - 10;
      const top = below >= Math.min(estimatedHeight, 180) ? anchor.bottom + 6 : Math.max(8, anchor.top - Math.min(estimatedHeight, window.innerHeight - 16) - 6);
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      setPosition({ position: "fixed", top, left, width, maxHeight: Math.min(estimatedHeight, window.innerHeight - top - 10), zIndex: 110 });
    };
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place); document.addEventListener("scroll", place, true);
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(null); (open === "start" ? startButton.current : endButton.current)?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open, options.length]);

  const select = (value: string) => { (open === "start" ? onStart : onEnd)(value); setOpen(null); };
  return <div className="kiosk-time-picker" ref={root}>
    <div className="kiosk-time-fields">
      <label><span className="field-label">시작 시간</span><button ref={startButton} id="kiosk-start" data-testid="kiosk-start" type="button" className="time-picker-toggle" aria-haspopup="listbox" aria-expanded={open === "start"} disabled={disabled} onClick={() => setOpen(value => value === "start" ? null : "start")}>{start}</button></label>
      <label><span className="field-label">종료 시간</span><button ref={endButton} id="kiosk-end" data-testid="kiosk-end" type="button" className="time-picker-toggle" aria-haspopup="listbox" aria-expanded={open === "end"} disabled={disabled} onClick={() => setOpen(value => value === "end" ? null : "end")}>{end}</button></label>
    </div>
    {open && <div className="time-picker-popover kiosk-time-picker-popover" role="listbox" aria-label={open === "start" ? "예약 가능한 시작 시간" : "예약 가능한 종료 시간"} style={position}>
      <div className="time-picker-popover-head"><b>{open === "start" ? "시작 시간" : "종료 시간"}</b><span>예약 가능한 시간만 표시</span></div>
      <div className="time-picker-slots">{options.map(value => <button type="button" role="option" aria-selected={value === (open === "start" ? start : end)} className={value === (open === "start" ? start : end) ? "selected" : ""} key={value} onClick={() => select(value)}>{value}</button>)}</div>
      {!options.length && <p>선택 가능한 시간이 없습니다.</p>}
    </div>}
  </div>;
}
