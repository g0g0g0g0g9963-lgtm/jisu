import { type MouseEvent as ReactMouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import siteConfig from "./config/site.json";
import { equipmentIcon, type Room } from "./lib/rooms";

function EquipmentSymbol({ item }: { item: string }) {
  const kind = equipmentIcon(item);
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === "BEAM" ? <><rect x="3" y="10" width="18" height="10" rx="2" /><circle cx="16" cy="15" r="2.5" /><path d="M6 14h3M6 17h2M7 6 5 4m7 2V3m5 3 2-2" /></>
      : kind === "BOARD" ? <><path d="M3 4h18M12 4V2M5 4v13h14V4M12 17v4m-4 0 4-4 4 4" /></>
      : kind === "SCREEN" ? <><path d="M3 4h18M5 4v13h14V4M12 17v4m-3 0h6" /></>
      : kind === "DISPLAY" ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8" /></>
      : kind === "CAM" ? <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></>
      : <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>}
  </svg>;
}

/** 실제 등록 장비만 표시하며, 보조 장비인 스크린은 주요 장비 뒤에 둔다. */
export function RoomEquipment({ room }: { room: Room }) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const equipment = [...new Set(room.equipment)].sort((a, b) => Number(equipmentIcon(a) === "SCREEN") - Number(equipmentIcon(b) === "SCREEN"));
  const visible = equipment.slice(0, siteConfig.timeline.equipmentPreviewLimit);
  const remaining = equipment.length - visible.length;

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return;
    const panel = panelRef.current;
    const anchor = triggerRef.current.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const gap = 8;
    panel.style.left = `${Math.max(gap, Math.min(window.innerWidth - bounds.width - gap, anchor.right - bounds.width))}px`;
    panel.style.top = `${Math.max(gap, Math.min(window.innerHeight - bounds.height - gap, anchor.bottom + gap))}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => panelRef.current?.hidePopover();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", close); document.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  if (!equipment.length) return null;
  const triggerProps = {
    type: "button" as const,
    popoverTarget: id,
    "aria-expanded": open,
    "aria-haspopup": "dialog" as const,
    "aria-controls": id,
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => { triggerRef.current = event.currentTarget; },
  };
  return <div className="room-equipment" aria-label={`${room.name} 장비`}>
    <div className="room-equipment-chips">
      {visible.map((item, index) => <button {...triggerProps} className={`room-equipment-chip${index > 0 ? " equipment-secondary" : ""}`} key={item} title={item} aria-label={`${item} · ${room.name} 전체 장비 보기`}>
        <EquipmentSymbol item={item} /><span>{item}</span>
      </button>)}
      {remaining > 0 && <button {...triggerProps} className="room-equipment-chip room-equipment-more equipment-wide-more" aria-label={`추가 장비 ${remaining}개 · ${room.name} 전체 장비 보기`}>+{remaining}</button>}
      {equipment.length > 1 && <button {...triggerProps} className="room-equipment-chip room-equipment-more equipment-compact-more" aria-label={`추가 장비 ${equipment.length - 1}개 · ${room.name} 전체 장비 보기`}>+{equipment.length - 1}</button>}
    </div>
    <div ref={panelRef} id={id} popover="auto" className="room-equipment-popover" role="dialog" aria-label={`${room.floor}층 ${room.name} 장비`} onToggle={event => setOpen(event.newState === "open")}>
      <div className="room-equipment-popover-head"><h3>회의실 장비</h3><button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label="장비 정보 닫기"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button></div>
      <p>{room.floor}F · {room.name}</p>
      <ul>{equipment.map(item => <li key={item}><EquipmentSymbol item={item} /><span>{item}</span></li>)}</ul>
    </div>
  </div>;
}
