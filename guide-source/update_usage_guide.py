from io import BytesIO
from pathlib import Path
from shutil import copy2

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name == "guide-source" else SCRIPT_DIR.parents[1]
GUIDE_SOURCE_DIR = ROOT / "guide-source"
ASSET_DIR = GUIDE_SOURCE_DIR / "assets"
SOURCE_PDF = GUIDE_SOURCE_DIR / "base" / "회의실예약_매뉴얼_기준본.pdf"
QUICK_SCREENSHOT = ASSET_DIR / "quick-booking.png"
REPEAT_SCREENSHOT = ASSET_DIR / "repeat-booking.png"
SCHEDULE_SCREENSHOT = ASSET_DIR / "schedule-overview.png"
DAILY_BOOKING_SCREENSHOT = ASSET_DIR / "daily-booking.png"
WEEKLY_BOOKING_SCREENSHOT = ASSET_DIR / "weekly-booking.png"
QUICK_BOOKING_FLOW_SCREENSHOT = ASSET_DIR / "quick-booking-flow.png"
FINAL_CONFIRM_SCREENSHOT = ASSET_DIR / "final-confirm.png"
NOTIFICATION_ICON_SCREENSHOT = ASSET_DIR / "notification-header.png"
MY_BOOKINGS_SCREENSHOT = ASSET_DIR / "my-bookings.png"
EDIT_BOOKING_SCREENSHOT = ASSET_DIR / "edit-booking.png"
OUTPUT_DIR = ROOT / "output" / "pdf"
OUTPUT_PDF = OUTPUT_DIR / "회의실예약_이용가이드.pdf"
WORK_DIR = ROOT / "tmp" / "pdfs" / "prepared"
KOREAN_FONT = Path(r"C:\Windows\Fonts\malgun.ttf")
KOREAN_BOLD_FONT = Path(r"C:\Windows\Fonts\malgunbd.ttf")


def prepare_screenshot(source: Path, target_size: tuple[int, int], output: Path) -> None:
    """Fit the screenshot without distortion, using white padding where needed."""
    with Image.open(source) as image:
        rgb = image.convert("RGB")
        rgb.thumbnail(target_size, Image.Resampling.LANCZOS)
        fitted = Image.new("RGB", target_size, "white")
        x = (target_size[0] - rgb.width) // 2
        y = (target_size[1] - rgb.height) // 2
        fitted.paste(rgb, (x, y))
        fitted.save(output, format="PNG", optimize=True)


def prepare_notification_icon(source: Path, output: Path) -> None:
    """Crop the bell and unread dot from the supplied header screenshot."""
    with Image.open(source) as image:
        cropped = image.convert("RGB").crop((278, 8, 323, 69))
        cropped.save(output, format="PNG", optimize=True)


def draw_wrapped_text(
    overlay: canvas.Canvas,
    text: str,
    x: float,
    baseline_y: float,
    max_width: float,
    font_name: str,
    font_size: float,
    color: str,
    line_height: float,
) -> None:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue

        current = ""
        for word in paragraph.split():
            candidate = word if not current else f"{current} {word}"
            if not current or pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_width:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)

    overlay.setFillColor(HexColor(color))
    overlay.setFont(font_name, font_size)
    for index, line in enumerate(lines):
        overlay.drawString(x, baseline_y - index * line_height, line)


def draw_notification_bell(
    overlay: canvas.Canvas,
    x: float,
    y: float,
    size: float,
) -> None:
    """Draw the site's navy bell and red unread dot without a bitmap background."""
    center_x = x + size * 0.46
    body = overlay.beginPath()
    body.moveTo(x + size * 0.14, y + size * 0.25)
    body.curveTo(
        x + size * 0.25,
        y + size * 0.36,
        x + size * 0.27,
        y + size * 0.46,
        x + size * 0.27,
        y + size * 0.60,
    )
    body.curveTo(
        x + size * 0.27,
        y + size * 0.79,
        x + size * 0.35,
        y + size * 0.88,
        center_x,
        y + size * 0.88,
    )
    body.curveTo(
        x + size * 0.57,
        y + size * 0.88,
        x + size * 0.66,
        y + size * 0.79,
        x + size * 0.66,
        y + size * 0.60,
    )
    body.curveTo(
        x + size * 0.66,
        y + size * 0.46,
        x + size * 0.68,
        y + size * 0.36,
        x + size * 0.79,
        y + size * 0.25,
    )
    body.lineTo(x + size * 0.14, y + size * 0.25)

    overlay.setStrokeColor(HexColor("#274783"))
    overlay.setLineWidth(1.45)
    overlay.setLineCap(1)
    overlay.setLineJoin(1)
    overlay.drawPath(body, stroke=1, fill=0)

    overlay.setFillColor(HexColor("#274783"))
    overlay.circle(center_x, y + size * 0.13, size * 0.075, stroke=0, fill=1)

    overlay.setFillColor(HexColor("#F31546"))
    overlay.setStrokeColor(HexColor("#FFFFFF"))
    overlay.setLineWidth(0.9)
    overlay.circle(
        x + size * 0.78,
        y + size * 0.82,
        size * 0.14,
        stroke=1,
        fill=1,
    )


def draw_solid_step_badge(
    overlay: canvas.Canvas,
    number: str,
    center_x: float,
    center_y: float,
    radius: float,
    font_size: float,
) -> None:
    """Draw the selected solid-coral guide marker with a restrained soft shadow."""
    overlay.setFillColor(HexColor("#DDE2EC"))
    overlay.circle(center_x + 0.9, center_y - 0.9, radius + 0.2, stroke=0, fill=1)
    overlay.setFillColor(HexColor("#ED1639"))
    overlay.circle(center_x, center_y, radius, stroke=0, fill=1)
    overlay.setFillColor(HexColor("#FFFFFF"))
    overlay.setFont("GuideKoreanBold", font_size)
    overlay.drawCentredString(center_x, center_y - font_size * 0.34, number)


def make_page_overlay(
    page_width: float,
    page_height: float,
    page_index: int,
    quick_screenshot: Path,
    schedule_screenshot: Path,
    notification_icon: Path,
    my_bookings_screenshot: Path,
    edit_booking_screenshot: Path,
) -> PdfReader:
    packet = BytesIO()
    overlay = canvas.Canvas(packet, pagesize=(page_width, page_height))
    if "GuideKorean" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("GuideKorean", str(KOREAN_FONT)))
    if "GuideKoreanBold" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("GuideKoreanBold", str(KOREAN_BOLD_FONT)))

    if page_index == 0:
        # Mask only the old cover title, preserving every other cover element.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(34, page_height - 116, 365, 43, stroke=0, fill=1)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 26)
        overlay.drawString(36, page_height - 103, "회의실 예약 이용가이드")

    if page_index == 1:
        # Remove the five red screenshot callouts. The screenshot is redrawn last
        # so its left edge stays complete where the callouts used to overlap it.
        overlay.setFillColorRGB(1, 1, 1)
        for center_top in (227.5, 267.0, 343.5, 400.5, 458.0):
            overlay.rect(30.5, page_height - center_top - 9, 19, 18, stroke=0, fill=1)
        overlay.drawImage(
            str(quick_screenshot),
            40,
            page_height - 480.204,
            width=172,
            height=320.6285,
            preserveAspectRatio=False,
            mask="auto",
        )

        # Replace the quick-booking explanations while retaining the numbered
        # circles and the rest of page 2 exactly as laid out.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(260, page_height - 447, 305, 282, stroke=0, fill=1)
        quick_items = (
            (
                173.38,
                "회의실 선택",
                "회의실 카드를 열고 원하는 회의실을 선택합니다.\n위치 아이콘을 눌러 회의실 배치도를 확인하실 수 있습니다.",
            ),
            (233.38, "예약 날짜", "예약할 날짜를 선택합니다."),
            (
                293.38,
                "시간 선택",
                "시작·종료 시간을 선택합니다. 1시간, 2시간, 4시간, 종일 버튼도 사용할 수 있습니다.",
            ),
            (
                353.38,
                "예약 정보 확인",
                "예약자 이름과 본부명은 필수 입력사항이며, 회의 목적과 참석자는 선택사항입니다.",
            ),
            (
                413.38,
                "예약 완료",
                "빨간 버튼에 표시된 회의실과 시간을 마지막으로 확인한 뒤 누릅니다.",
            ),
        )
        for heading_top, heading, body in quick_items:
            heading_size = 9.9
            body_size = 9.05
            draw_wrapped_text(
                overlay,
                heading,
                264,
                page_height - heading_top - heading_size,
                296,
                "GuideKorean",
                heading_size,
                "#17223A",
                13,
            )
            draw_wrapped_text(
                overlay,
                body,
                264,
                page_height - (heading_top + 16.64) - body_size,
                296,
                "GuideKorean",
                body_size,
                "#6F7A91",
                12.95,
            )

        # Add the alternate drag gesture to the existing repeat-booking guide.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(262, page_height - 634, 302, 19, stroke=0, fill=1)
        draw_wrapped_text(
            overlay,
            "시작일·반복일을 고르거나 달력에서 드래그해 기간을 선택할 수 있습니다.",
            264,
            page_height - 620.02 - 8.9,
            296,
            "GuideKorean",
            8.9,
            "#6F7A91",
            12.5,
        )

    if page_index == 2:
        # Rebuild the page body around the new schedule screenshot. This masks
        # the former floor-plan section and its callouts while preserving the
        # page title and footer.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(34, 26, 527, page_height - 126, stroke=0, fill=1)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 10.5)
        overlay.drawString(36, page_height - 116, "일간·주간 예약 현황 보기")
        overlay.setFillColor(HexColor("#6F7A91"))
        overlay.setFont("GuideKorean", 9.1)
        overlay.drawString(
            196,
            page_height - 116,
            "층과 날짜를 선택하고 일간/주간 버튼으로 예약 현황을 확인합니다.",
        )

        image_x = 36
        image_top = 139
        image_width = 523
        with Image.open(schedule_screenshot) as schedule_image:
            source_width, source_height = schedule_image.size
        image_height = 252
        overlay.setStrokeColor(HexColor("#D9E1EE"))
        overlay.setLineWidth(0.8)
        overlay.roundRect(
            image_x,
            page_height - image_top - image_height,
            image_width,
            image_height,
            7,
            stroke=1,
            fill=0,
        )
        overlay.drawImage(
            str(schedule_screenshot),
            image_x + 1,
            page_height - image_top - image_height + 1,
            width=image_width - 2,
            height=image_height - 2,
            preserveAspectRatio=False,
            mask="auto",
        )

        # Match the screenshot controls and booking colors to the numbered
        # explanations below.
        callouts = (
            ("01", 421, 62),
            ("02", 951, 62),
            ("03", 1785, 62),
            ("04", 1380, 322),
            ("05", 505, 322),
        )
        for number, source_x, source_y in callouts:
            callout_x = image_x + source_x / source_width * image_width
            callout_y = page_height - (
                image_top + source_y / source_height * image_height
            )
            draw_solid_step_badge(
                overlay,
                number,
                callout_x,
                callout_y,
                7.6,
                6.1,
            )

        schedule_items = (
            (
                "01",
                "층 선택",
                "9F/12F 버튼을 눌러 원하는 층의 회의실 예약 현황을 확인합니다.",
                None,
            ),
            (
                "02",
                "날짜 이동",
                "화살표와 오늘 버튼으로 날짜를 이동하고, 달력 아이콘으로 원하는 날짜를 선택합니다.",
                None,
            ),
            (
                "03",
                "보기 전환",
                "일간/주간 버튼을 눌러 예약 현황의 보기 방식을 전환합니다.",
                None,
            ),
            (
                "04",
                "연한 붉은색 예약",
                "내 예약입니다. 예약 블록을 눌러 내용을 확인하고 수정하거나 취소할 수 있습니다.",
                "#F7DEE5",
            ),
            (
                "05",
                "연한 남색 예약",
                "다른 사람이 예약한 시간입니다. 예약 블록을 눌러 예약 내용만 확인할 수 있습니다.",
                "#DCE6F5",
            ),
        )
        item_top = image_top + image_height + 25
        item_gap = 60
        for item_index, (number, heading, body, swatch_color) in enumerate(schedule_items):
            top = item_top + item_index * item_gap
            circle_x = 47
            circle_y = page_height - top - 9
            overlay.setFillColor(HexColor("#F2F5FA"))
            overlay.setStrokeColor(HexColor("#D8E0EC"))
            overlay.circle(circle_x, circle_y, 9, stroke=1, fill=1)
            overlay.setFillColor(HexColor("#24314A"))
            overlay.setFont("GuideKorean", 7.4)
            overlay.drawCentredString(circle_x, circle_y - 2.6, number)

            heading_x = 66
            if swatch_color:
                overlay.setFillColor(HexColor(swatch_color))
                overlay.roundRect(heading_x, page_height - top - 13, 22, 12, 4, stroke=0, fill=1)
                heading_x += 29
            overlay.setFillColor(HexColor("#17223A"))
            overlay.setFont("GuideKorean", 10.3)
            overlay.drawString(heading_x, page_height - top - 10.3, heading)
            draw_wrapped_text(
                overlay,
                body,
                66,
                page_height - top - 30,
                487,
                "GuideKorean",
                9.1,
                "#6F7A91",
                12.5,
            )

    if page_index == 3:
        # Replace the old schedule-booking walkthrough with the current daily,
        # weekly, quick-booking, and final-confirmation screens.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(34, 26, 527, page_height - 126, stroke=0, fill=1)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 14.5)
        overlay.drawString(36, page_height - 119, "두 가지 방법으로 시작합니다")
        overlay.setFillColor(HexColor("#6F7A91"))
        overlay.setFont("GuideKorean", 9.3)
        overlay.drawString(
            36,
            page_height - 141,
            "일간에서는 빈 시간을 드래그하고, 주간에서는 원하는 빈 칸을 더블클릭합니다.",
        )

        def draw_step_badge(number: str, x: float, top: float) -> None:
            center_y = page_height - top - 9
            overlay.setFillColor(HexColor("#F2F5FA"))
            overlay.setStrokeColor(HexColor("#D8E0EC"))
            overlay.circle(x, center_y, 9, stroke=1, fill=1)
            overlay.setFillColor(HexColor("#24314A"))
            overlay.setFont("GuideKorean", 7.4)
            overlay.drawCentredString(x, center_y - 2.6, number)

        def draw_framed_image(path: Path, x: float, top: float, width: float, height: float) -> None:
            overlay.setStrokeColor(HexColor("#D9E1EE"))
            overlay.setLineWidth(0.75)
            overlay.roundRect(x, page_height - top - height, width, height, 7, stroke=1, fill=0)
            overlay.drawImage(
                str(path),
                x + 1,
                page_height - top - height + 1,
                width=width - 2,
                height=height - 2,
                preserveAspectRatio=False,
                mask="auto",
            )

        # Step 1: two entry methods into the same quick-booking flow.
        draw_step_badge("01", 45, 163)
        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 10.4)
        overlay.drawString(63, page_height - 173, "일정표에서 시간 선택")

        overlay.setFillColor(HexColor("#FCE9EE"))
        overlay.roundRect(36, page_height - 202, 35, 16, 8, stroke=0, fill=1)
        overlay.setFillColor(HexColor("#C21238"))
        overlay.setFont("GuideKorean", 8)
        overlay.drawCentredString(53.5, page_height - 197, "일간")
        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 9.2)
        overlay.drawString(77, page_height - 197, "빈 시간을 원하는 종료 시각까지 드래그")

        overlay.setFillColor(HexColor("#EAF0FA"))
        overlay.roundRect(301, page_height - 202, 35, 16, 8, stroke=0, fill=1)
        overlay.setFillColor(HexColor("#294579"))
        overlay.setFont("GuideKorean", 8)
        overlay.drawCentredString(318.5, page_height - 197, "주간")
        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 9.2)
        overlay.drawString(342, page_height - 197, "원하는 날짜와 회의실의 빈 칸을 더블클릭")

        draw_framed_image(DAILY_BOOKING_SCREENSHOT, 36, 216, 258, 138)
        draw_framed_image(WEEKLY_BOOKING_SCREENSHOT, 301, 216, 258, 138)

        overlay.setStrokeColor(HexColor("#E1E6EF"))
        overlay.setLineWidth(0.6)
        overlay.line(36, page_height - 374, 559, page_height - 374)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 12.2)
        overlay.drawString(36, page_height - 399, "이후 예약 과정은 같습니다")

        # Step 2: the selected slot is transferred to the quick-booking panel.
        draw_step_badge("02", 45, 416)
        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 10.4)
        overlay.drawString(63, page_height - 426, "빠른예약창에서 내용 확인")

        # Separate the daily and weekly instructions into individual soft
        # panels so their different behavior can be understood at a glance.
        overlay.setFillColor(HexColor("#FFF2F5"))
        overlay.roundRect(63, page_height - 489, 190, 44, 7, stroke=0, fill=1)
        overlay.setFillColor(HexColor("#C21238"))
        overlay.setFont("GuideKorean", 8.2)
        overlay.drawString(73, page_height - 458, "일간")
        draw_wrapped_text(
            overlay,
            "회의실·날짜·시간이 자동으로 채워집니다. 내용을 확인합니다.",
            73,
            page_height - 473,
            170,
            "GuideKorean",
            8.1,
            "#59657D",
            10.5,
        )

        overlay.setFillColor(HexColor("#F1F5FB"))
        overlay.roundRect(63, page_height - 540, 190, 44, 7, stroke=0, fill=1)
        overlay.setFillColor(HexColor("#294579"))
        overlay.setFont("GuideKorean", 8.2)
        overlay.drawString(73, page_height - 509, "주간")
        draw_wrapped_text(
            overlay,
            "회의실만 자동 반영됩니다. 시작·종료 시간을 직접 선택합니다.",
            73,
            page_height - 524,
            170,
            "GuideKorean",
            8.1,
            "#59657D",
            10.5,
        )

        overlay.setFillColor(HexColor("#C21238"))
        overlay.setFont("GuideKorean", 8.5)
        overlay.drawString(73, page_height - 558, "내용 확인 후 예약하기를 누릅니다.")
        draw_framed_image(QUICK_BOOKING_FLOW_SCREENSHOT, 84, 574, 128, 238)

        # Step 3: one final confirmation before the booking is committed.
        draw_step_badge("03", 285, 416)
        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 10.4)
        overlay.drawString(303, page_height - 426, "마지막 확인 후 예약 확정")
        draw_wrapped_text(
            overlay,
            "예약 내용을 확인하고 수정이 필요하면 수정하기를 누릅니다. 예약하기를 누르면 예약이 확정됩니다.",
            303,
            page_height - 449,
            250,
            "GuideKorean",
            8.9,
            "#6F7A91",
            12.5,
        )
        draw_framed_image(FINAL_CONFIRM_SCREENSHOT, 303, 489, 228, 165)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 9.4)
        overlay.drawString(303, page_height - 681, "마지막 예약하기를 누르는 즉시 예약이 확정됩니다.")

    if page_index == 4:
        # Move the notification guidance next to the My Bookings walkthrough.
        # The supplied header screenshot is cropped to the bell itself so the
        # action is immediately recognizable without repeating the full header.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(34, page_height - 184, 527, 78, stroke=0, fill=1)

        overlay.setFillColor(HexColor("#F5F7FB"))
        overlay.setStrokeColor(HexColor("#D9E1EE"))
        overlay.setLineWidth(0.7)
        overlay.roundRect(36, page_height - 147, 34, 34, 9, stroke=1, fill=1)
        draw_notification_bell(
            overlay,
            42.5,
            page_height - 141.5,
            21,
        )

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 12.2)
        overlay.drawString(79, page_height - 135, "알림에서 내 예약 확인")
        draw_wrapped_text(
            overlay,
            "화면 상단의 알림 아이콘을 누르면 ‘내 예약’ 창이 바로 열립니다.\n예정 예약과 지난 예약을 확인하고, 필요한 예약을 선택해 수정하거나 취소할 수 있습니다.",
            36,
            page_height - 160,
            515,
            "GuideKorean",
            8.9,
            "#6F7A91",
            14,
        )

        # Replace the former wide crop with the current full My Bookings dialog.
        # It is fitted at its native aspect ratio so rows and buttons stay clear.
        screenshot_x = 118.5
        screenshot_top = 182
        screenshot_width = 358
        screenshot_height = 250.3
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(80, page_height - 447, 440, 265, stroke=0, fill=1)
        overlay.setStrokeColor(HexColor("#D9E1EE"))
        overlay.setLineWidth(0.75)
        overlay.roundRect(
            screenshot_x,
            page_height - screenshot_top - screenshot_height,
            screenshot_width,
            screenshot_height,
            7,
            stroke=1,
            fill=0,
        )
        overlay.drawImage(
            str(my_bookings_screenshot),
            screenshot_x + 1,
            page_height - screenshot_top - screenshot_height + 1,
            width=screenshot_width - 2,
            height=screenshot_height - 2,
            preserveAspectRatio=False,
            mask="auto",
        )

        # Refresh the edit-dialog example with the current soft-surface design.
        edit_x = 36
        edit_top = 474
        edit_width = 190
        edit_height = 266.5
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(35, page_height - 780, 195, 310, stroke=0, fill=1)
        overlay.setStrokeColor(HexColor("#D9E1EE"))
        overlay.setLineWidth(0.75)
        overlay.roundRect(
            edit_x,
            page_height - edit_top - edit_height,
            edit_width,
            edit_height,
            7,
            stroke=1,
            fill=0,
        )
        overlay.drawImage(
            str(edit_booking_screenshot),
            edit_x + 1,
            page_height - edit_top - edit_height + 1,
            width=edit_width - 2,
            height=edit_height - 2,
            preserveAspectRatio=False,
            mask="auto",
        )

    if page_index == 5:
        # Rebuild the troubleshooting table from the current site behaviour.
        # The source PDF still described the old required fields and the former
        # two-step button labels, so masking the whole table avoids leaving any
        # stale text underneath the revised guidance.
        table_x = 36
        table_top = 162
        table_width = 523
        situation_width = 178
        header_height = 28
        row_height = 52
        table_bottom = table_top + header_height + row_height * 8

        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(
            table_x - 2,
            page_height - table_bottom - 2,
            table_width + 4,
            table_bottom - table_top + 4,
            stroke=0,
            fill=1,
        )

        overlay.setFillColor(HexColor("#F5F6F8"))
        overlay.rect(
            table_x,
            page_height - table_top - header_height,
            table_width,
            header_height,
            stroke=0,
            fill=1,
        )

        help_rows = (
            (
                "‘이미 예약된 시간입니다’가 표시됨",
                "선택한 시간에 다른 예약이 있습니다. 다른 시간이나 회의실을 선택하세요.",
            ),
            (
                "예약하기를 눌렀는데\n입력칸 안내가 표시됨",
                "예약자 이름과 본부명은 필수입니다. 안내된 칸을 입력하세요.\n회의 목적과 참석자는 선택사항입니다.",
            ),
            (
                "알림 아이콘을 눌렀는데\n내 예약이 보이지 않음",
                "예약자 이름이 예약할 때 사용한 이름과 같은지 확인하세요.\n지난 예약은 최근 1개월까지만 표시됩니다.",
            ),
            (
                "찾는 회의실이 표에 없음",
                "9F/12F 층 버튼을 확인하세요. 선택한 층의 회의실만 표시됩니다.",
            ),
            (
                "원하는 날짜의 예약 현황이\n보이지 않음",
                "화살표나 달력 아이콘으로 날짜를 이동하세요.\n‘오늘’을 누르면 오늘로 돌아옵니다.",
            ),
            (
                "일정표에서 빠른예약창이\n열리지 않음",
                "일간은 빈 시간을 드래그하고, 주간은 원하는 날짜·회의실의\n빈 칸을 더블클릭하세요.",
            ),
            (
                "예약하기를 눌렀는데\n예약이 확정되지 않음",
                "빠른예약창의 예약하기를 누른 뒤, 마지막 확인창에서\n예약하기를 한 번 더 누르면 확정됩니다.",
            ),
            (
                "참석자가 회의실 정원을 넘음",
                "정원 초과 안내가 표시되지만 예약은 가능합니다.\n참석 인원에 맞는 회의실인지 다시 확인하세요.",
            ),
        )

        for index, (situation, action) in enumerate(help_rows):
            row_top = table_top + header_height + index * row_height
            if index % 2 == 1:
                overlay.setFillColor(HexColor("#FAFBFC"))
                overlay.rect(
                    table_x,
                    page_height - row_top - row_height,
                    table_width,
                    row_height,
                    stroke=0,
                    fill=1,
                )

            draw_wrapped_text(
                overlay,
                situation,
                table_x + 8,
                page_height - row_top - 18,
                situation_width - 16,
                "GuideKorean",
                8.8,
                "#17223A",
                12.3,
            )
            draw_wrapped_text(
                overlay,
                action,
                table_x + situation_width + 8,
                page_height - row_top - 18,
                table_width - situation_width - 16,
                "GuideKorean",
                8.55,
                "#17223A",
                12.3,
            )

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 9.3)
        overlay.drawString(table_x + 8, page_height - table_top - 18, "이런 상황이면")
        overlay.drawString(
            table_x + situation_width + 8,
            page_height - table_top - 18,
            "이렇게 하세요",
        )

        overlay.setStrokeColor(HexColor("#D6DEEA"))
        overlay.setLineWidth(0.55)
        overlay.rect(
            table_x,
            page_height - table_bottom,
            table_width,
            table_bottom - table_top,
            stroke=1,
            fill=0,
        )
        overlay.line(
            table_x + situation_width,
            page_height - table_top,
            table_x + situation_width,
            page_height - table_bottom,
        )
        for index in range(9):
            line_top = table_top + header_height + index * row_height
            overlay.line(
                table_x,
                page_height - line_top,
                table_x + table_width,
                page_height - line_top,
            )

        # The notification guidance now belongs to page 5. Clear the former
        # last-page section, then use the open lower area for contact details.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(34, page_height - 812, 527, 197, stroke=0, fill=1)

        overlay.setStrokeColor(HexColor("#E1E6EF"))
        overlay.setLineWidth(0.6)
        overlay.line(36, page_height - 630, 559, page_height - 630)

        overlay.setFillColor(HexColor("#17223A"))
        overlay.setFont("GuideKorean", 12.2)
        overlay.drawString(36, page_height - 656, "문의")

        overlay.setFillColor(HexColor("#F7F9FC"))
        overlay.setStrokeColor(HexColor("#D9E1EE"))
        overlay.setLineWidth(0.65)
        overlay.roundRect(36, page_height - 742, 523, 70, 8, stroke=1, fill=1)

        contact_lines = (
            ("· 사용방법 · 개선사항 · 버그", " : 김지수 책임"),
            ("· 접속 · 네트워크", " : 김진규 책임"),
        )
        for index, (topic, owner) in enumerate(contact_lines):
            baseline = page_height - 696 - index * 24
            overlay.setFillColor(HexColor("#17223A"))
            overlay.setFont("GuideKoreanBold", 9.7)
            overlay.drawString(52, baseline, topic)
            owner_x = 52 + pdfmetrics.stringWidth(topic, "GuideKoreanBold", 9.7)
            overlay.setFillColor(HexColor("#59657D"))
            overlay.setFont("GuideKorean", 9.7)
            overlay.drawString(owner_x, baseline, owner)

        # Redraw the page number because the cleared area's lower edge touches
        # the original footer glyphs on this page.
        overlay.setFillColorRGB(1, 1, 1)
        overlay.rect(532, page_height - 834, 31, 14, stroke=0, fill=1)
        overlay.setFillColor(HexColor("#6F7A91"))
        overlay.setFont("GuideKorean", 7.1)
        overlay.drawRightString(559, page_height - 829, "6 / 6")

    # Keep the document name consistent in the footer on every page.
    overlay.setFillColorRGB(1, 1, 1)
    overlay.rect(34, page_height - 834, 170, 14, stroke=0, fill=1)
    overlay.setFillColor(HexColor("#6F7A91"))
    overlay.setFont("GuideKorean", 7.1)
    overlay.drawString(36, page_height - 829, "BDO 성현회계법인 · 회의실 예약 이용가이드")
    overlay.save()
    packet.seek(0)
    return PdfReader(packet)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(SOURCE_PDF)
    if len(reader.pages) != 6:
        raise ValueError(f"Expected 6 pages, found {len(reader.pages)}")

    writer = PdfWriter()
    writer.clone_document_from_reader(reader)

    page_two_images = list(writer.pages[1].images)

    quick_prepared = WORK_DIR / "quick-booking.png"
    repeat_prepared = WORK_DIR / "repeat-booking.png"
    notification_icon = WORK_DIR / "notification-icon.png"
    prepare_screenshot(QUICK_SCREENSHOT, (471, 878), quick_prepared)
    prepare_screenshot(REPEAT_SCREENSHOT, (433, 654), repeat_prepared)
    prepare_notification_icon(NOTIFICATION_ICON_SCREENSHOT, notification_icon)

    quick_matches = [image for image in page_two_images if image.image.size == (471, 878)]
    repeat_matches = [image for image in page_two_images if image.image.size == (433, 654)]
    if not quick_matches or not repeat_matches:
        raise ValueError("Could not locate the page 2 quick/repeat screenshots")
    with Image.open(quick_prepared) as quick_image:
        for page_image in quick_matches:
            page_image.replace(quick_image)
    with Image.open(repeat_prepared) as repeat_image:
        for page_image in repeat_matches:
            page_image.replace(repeat_image)

    for index, page in enumerate(writer.pages):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        page_overlay = make_page_overlay(
            width,
            height,
            index,
            quick_prepared,
            SCHEDULE_SCREENSHOT,
            notification_icon,
            MY_BOOKINGS_SCREENSHOT,
            EDIT_BOOKING_SCREENSHOT,
        )
        page.merge_page(page_overlay.pages[0])

    metadata = {str(key): str(value) for key, value in (reader.metadata or {}).items()}
    metadata["/Title"] = "회의실 예약 이용가이드"
    writer.add_metadata(metadata)
    with OUTPUT_PDF.open("wb") as stream:
        writer.write(stream)

    check = PdfReader(OUTPUT_PDF)
    if len(check.pages) != 6:
        raise ValueError("Output PDF page count changed unexpectedly")

    for site_pdf in (
        ROOT / "public" / "회의실예약_매뉴얼.pdf",
        ROOT / "dist" / "회의실예약_매뉴얼.pdf",
    ):
        site_pdf.parent.mkdir(parents=True, exist_ok=True)
        copy2(OUTPUT_PDF, site_pdf)
    print(OUTPUT_PDF)


if __name__ == "__main__":
    main()
