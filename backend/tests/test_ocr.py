from io import BytesIO

import fitz
import pytest
from PIL import Image, ImageDraw, ImageFont

from app.documents.processing import get_ocr_adapter


def _scanned_page() -> bytes:
    image = Image.new("RGB", (1400, 220), "white")
    draw = ImageDraw.Draw(image)
    draw.text(
        (40, 70),
        "Student Name: OCR Test Student",
        fill="black",
        font=ImageFont.load_default(size=48),
    )
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_local_ocr_reads_images_and_scanned_pdf():
    adapter = get_ocr_adapter()
    if adapter is None:
        pytest.skip("Tesseract is not installed.")

    image = _scanned_page()
    image_text = adapter.extract_text(content=image, content_type="image/png")
    assert "OCR Test Student" in image_text

    with fitz.open() as document:
        page = document.new_page(width=700, height=110)
        page.insert_image(page.rect, stream=image)
        scanned_pdf = document.tobytes()
    pdf_text = adapter.extract_text(content=scanned_pdf, content_type="application/pdf")
    assert "OCR Test Student" in pdf_text
