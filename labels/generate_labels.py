#!/usr/bin/env python3
"""
Generate barcode label images (50mm x 25mm at 203 DPI = 400x200 px)
for Nawabi Chai House raw material inventory items.

Uses Code 128 barcodes via python-barcode and Pillow for image composition.
"""

import os
from io import BytesIO

import barcode
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFont

# --- Configuration ---
# 2x oversampled for thermal printer clarity (50mm x 25mm at 406 effective DPI)
LABEL_WIDTH = 800
LABEL_HEIGHT = 400
DPI = 406
BG_COLOR = "white"
FG_COLOR = "black"
PADDING_X = 24
PADDING_TOP = 16
PADDING_BOTTOM = 12

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Product definitions: (name, barcode_code, unit)
PRODUCTS = [
    ("Tea Powder",             "RM-TEA",  "kg"),
    ("Milk Powder",            "RM-SMP",  "kg"),
    ("Condensed Milk",         "RM-CM",   "kg"),
    ("Buffalo Milk",           "RM-BFM",  "L"),
    ("Sugar",                  "RM-SUG",  "kg"),
    ("Buns",                   "RM-BUN",  "pcs"),
    ("Chicken Cutlet (Raw)",   "RM-CCT",  "pcs"),
    ("Osmania (Loose)",        "RM-OSMG", "pcs"),
    ("Osmania Box",            "RM-OSMN", "box"),
    ("Filter Water",           "RM-WTR",  "L"),
    ("Bottled Water",          "RM-BWR",  "pcs"),
]


def get_font(size, bold=False):
    """Try to load a good system font, fall back to default."""
    # Common fonts on macOS
    font_paths_bold = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText-Bold.otf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
    ]
    font_paths_regular = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.otf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    paths = font_paths_bold if bold else font_paths_regular
    for path in paths:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    # Absolute fallback
    return ImageFont.load_default()


def generate_barcode_image(code_value):
    """Generate a Code128 barcode as a PIL Image (no text underneath)."""
    Code128 = barcode.get_barcode_class("code128")
    writer = ImageWriter()
    # We suppress the built-in text; we render it ourselves for layout control
    bc = Code128(code_value, writer=writer)
    buf = BytesIO()
    bc.write(buf, options={
        "write_text": False,
        "module_width": 0.5,
        "module_height": 18,
        "quiet_zone": 3,
        "font_size": 0,
        "text_distance": 0,
        "dpi": DPI,
    })
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def create_label(name, code, unit):
    """Create a single 400x200 label image."""
    img = Image.new("RGB", (LABEL_WIDTH, LABEL_HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Fonts (2x size for high-res)
    font_title = get_font(32, bold=True)
    font_small = get_font(24, bold=False)

    # --- Product name (top center, bold) ---
    title_bbox = draw.textbbox((0, 0), name, font=font_title)
    title_w = title_bbox[2] - title_bbox[0]
    title_x = (LABEL_WIDTH - title_w) // 2
    title_y = PADDING_TOP
    draw.text((title_x, title_y), name, fill=FG_COLOR, font=font_title)

    # --- Bottom text line ---
    bottom_text_left = code
    bottom_text_right = unit

    left_bbox = draw.textbbox((0, 0), bottom_text_left, font=font_small)
    left_h = left_bbox[3] - left_bbox[1]
    bottom_y = LABEL_HEIGHT - PADDING_BOTTOM - left_h

    # Left: barcode code value
    draw.text((PADDING_X, bottom_y), bottom_text_left, fill=FG_COLOR, font=font_small)

    # Right: unit of measure
    right_bbox = draw.textbbox((0, 0), bottom_text_right, font=font_small)
    right_w = right_bbox[2] - right_bbox[0]
    draw.text((LABEL_WIDTH - PADDING_X - right_w, bottom_y), bottom_text_right,
              fill=FG_COLOR, font=font_small)

    # --- Barcode (middle area) ---
    title_bottom = title_y + (title_bbox[3] - title_bbox[1]) + 12
    barcode_top = title_bottom
    barcode_bottom = bottom_y - 12
    available_h = barcode_bottom - barcode_top

    bc_img = generate_barcode_image(code)

    # Scale barcode to fit available space
    max_bc_width = LABEL_WIDTH - 2 * PADDING_X
    scale_w = max_bc_width / bc_img.width
    scale_h = available_h / bc_img.height
    scale = min(scale_w, scale_h)

    new_w = int(bc_img.width * scale)
    new_h = int(bc_img.height * scale)
    bc_img = bc_img.resize((new_w, new_h), Image.LANCZOS)

    # Center barcode horizontally, vertically in available space
    bc_x = (LABEL_WIDTH - new_w) // 2
    bc_y = barcode_top + (available_h - new_h) // 2
    img.paste(bc_img, (bc_x, bc_y))

    # --- Thin border for clean look ---
    draw.rectangle(
        [(0, 0), (LABEL_WIDTH - 1, LABEL_HEIGHT - 1)],
        outline="#CCCCCC", width=1
    )

    return img


def create_combined_grid(label_images, cols=2):
    """Arrange label images in a grid and return combined image."""
    rows = (len(label_images) + cols - 1) // cols
    gap = 10
    grid_w = cols * LABEL_WIDTH + (cols - 1) * gap + 2 * gap
    grid_h = rows * LABEL_HEIGHT + (rows - 1) * gap + 2 * gap

    combined = Image.new("RGB", (grid_w, grid_h), "#F0F0F0")

    for idx, lbl_img in enumerate(label_images):
        row = idx // cols
        col = idx % cols
        x = gap + col * (LABEL_WIDTH + gap)
        y = gap + row * (LABEL_HEIGHT + gap)
        combined.paste(lbl_img, (x, y))

    return combined


def create_combined_pdf(label_images, output_path):
    """Create a PDF with one label per page."""
    if not label_images:
        return
    # Convert all to RGB for PDF compatibility
    pages = [img.convert("RGB") for img in label_images]
    pages[0].save(
        output_path,
        save_all=True,
        append_images=pages[1:],
        resolution=DPI,
    )


def main():
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Generating {len(PRODUCTS)} barcode labels...\n")

    label_images = []

    for name, code, unit in PRODUCTS:
        img = create_label(name, code, unit)
        filename = f"{code}.png"
        filepath = os.path.join(OUTPUT_DIR, filename)
        img.save(filepath, "PNG", dpi=(DPI, DPI))
        label_images.append(img)
        print(f"  Created: {filename}  ({name})")

    # Combined grid image
    grid_img = create_combined_grid(label_images, cols=2)
    grid_path = os.path.join(OUTPUT_DIR, "ALL_LABELS_GRID.png")
    grid_img.save(grid_path, "PNG", dpi=(DPI, DPI))
    print(f"\n  Combined grid: ALL_LABELS_GRID.png")

    # Combined PDF
    pdf_path = os.path.join(OUTPUT_DIR, "ALL_LABELS.pdf")
    create_combined_pdf(label_images, pdf_path)
    print(f"  Combined PDF:  ALL_LABELS.pdf")

    print(f"\nDone! {len(label_images)} labels + grid + PDF saved to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
