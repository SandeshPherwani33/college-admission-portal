from __future__ import annotations

import re
import shutil
import warnings
from dataclasses import dataclass
from io import BytesIO
from math import sqrt
import os
from pathlib import Path, PurePath
from typing import Protocol

import pymupdf as fitz
import pytesseract
from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader
from pypdf.errors import PdfReadError


_MAX_OCR_PAGES = 10
_MAX_OCR_IMAGE_PIXELS = 20_000_000
_MAX_OCR_IMAGE_EDGE = 3000
_OCR_TIMEOUT_SECONDS = 12
_MIME_BY_EXTENSION = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}
_FIELD_NAMES = (
    "student_name",
    "institution",
    "qualification",
    "marks",
    "maximum_marks",
    "percentage",
    "examination_year",
    "cgpa",
)
_TEXT_EXTRACTION_ERRORS = (
    PdfReadError,
    ValueError,
    OSError,
    KeyError,
    IndexError,
    TypeError,
)
_NUMBER_PATTERN = r"\d+(?:[.,]\d+)?"
_MAX_EVIDENCE_LENGTH = 300


class DocumentProcessingError(ValueError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class OCRAdapterError(Exception):
    pass


class OCRAdapter(Protocol):
    def extract_text(self, *, content: bytes, content_type: str) -> str:
        ...


class TesseractOCRAdapter:
    def __init__(self, executable: str) -> None:
        self.executable = executable
        pytesseract.pytesseract.tesseract_cmd = executable

    def extract_text(self, *, content: bytes, content_type: str) -> str:
        if content_type == "application/pdf":
            return self._extract_pdf_text(content)
        if content_type in {"image/jpeg", "image/png"}:
            with Image.open(BytesIO(content)) as image:
                if image.width * image.height > _MAX_OCR_IMAGE_PIXELS:
                    raise OCRAdapterError("Image is too large for local OCR processing.")
                return self._recognize(image.convert("RGB"))
        raise OCRAdapterError("This document type is not supported by local OCR.")

    def _extract_pdf_text(self, content: bytes) -> str:
        try:
            with fitz.open(stream=content, filetype="pdf") as document:
                if document.page_count > _MAX_OCR_PAGES:
                    raise OCRAdapterError(
                        f"Scanned PDFs are limited to {_MAX_OCR_PAGES} pages for OCR."
                    )
                page_text = []
                for page in document:
                    page_width = page.rect.width
                    page_height = page.rect.height
                    if page_width <= 0 or page_height <= 0:
                        raise OCRAdapterError("PDF contains a page with invalid dimensions.")
                    scale = min(
                        2.0,
                        _MAX_OCR_IMAGE_EDGE / max(page_width, page_height),
                        sqrt(_MAX_OCR_IMAGE_PIXELS / (page_width * page_height)),
                    )
                    pixmap = page.get_pixmap(
                        matrix=fitz.Matrix(scale, scale),
                        colorspace=fitz.csRGB,
                        alpha=False,
                    )
                    image = Image.frombytes(
                        "RGB",
                        (pixmap.width, pixmap.height),
                        pixmap.samples,
                    )
                    page_text.append(self._recognize(image))
                return "\n".join(page_text)
        except OCRAdapterError:
            raise
        except (fitz.FileDataError, fitz.EmptyFileError, RuntimeError, ValueError) as exc:
            raise OCRAdapterError("Could not render the PDF for local OCR.") from exc

    @staticmethod
    def _recognize(image: Image.Image) -> str:
        try:
            return pytesseract.image_to_string(
                image,
                lang="eng",
                config="--psm 6",
                timeout=_OCR_TIMEOUT_SECONDS,
            )
        except (pytesseract.TesseractError, RuntimeError, OSError) as exc:
            raise OCRAdapterError("The local OCR engine could not read this document.") from exc


@dataclass(frozen=True)
class ProcessedDocument:
    content_type: str
    status: str
    extraction_status: str
    ocr_status: str
    extracted_fields: dict[str, str | float | int | None]
    extraction_evidence: dict[str, list[str]]
    extraction_methods: dict[str, str]
    warnings: list[str]


@dataclass(frozen=True)
class _TextExtractionResult:
    text: str | None
    status: str
    warning: str | None = None


def get_ocr_adapter() -> OCRAdapter | None:
    executable = shutil.which("tesseract")
    if executable is None and os.name == "nt":
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        candidate = program_files / "Tesseract-OCR" / "tesseract.exe"
        if candidate.is_file():
            executable = str(candidate)
    return TesseractOCRAdapter(executable) if executable else None


def validate_filename(filename: str | None) -> str:
    if (
        not filename
        or filename != filename.strip()
        or len(filename) > 255
        or filename in {".", ".."}
        or "/" in filename
        or "\\" in filename
        or any(ord(character) < 32 or ord(character) == 127 for character in filename)
    ):
        raise DocumentProcessingError("Filename is empty or unsafe.")
    if PurePath(filename).name != filename:
        raise DocumentProcessingError("Filename must not contain a path.")
    return filename


def empty_academic_fields() -> dict[str, str | float | int | None]:
    return {field: None for field in _FIELD_NAMES}


def _evidence_excerpt(line: str) -> str:
    return " ".join(line.split())[:_MAX_EVIDENCE_LENGTH]


def _label_value(
    text: str,
    labels: tuple[str, ...],
    maximum_length: int,
    evidence: dict[str, list[str]],
    field_name: str,
) -> str | None:
    label_pattern = "|".join(re.escape(label) for label in labels)
    match = re.search(
        rf"(?im)^\s*(?:{label_pattern})\s*[:\-]\s*(.*?)\s*$",
        text,
    )
    value = match.group(1).strip() if match else ""
    if not value or len(value) > maximum_length:
        return None
    if value.casefold() in {"unknown", "not provided", "n/a", "na", "none"}:
        return None
    evidence[field_name] = [_evidence_excerpt(match.group(0))]
    return value


def _number(value: str | None) -> float | None:
    if value is None:
        return None
    normalized = value.strip()
    if "," in normalized and "." in normalized:
        normalized = normalized.replace(",", "")
    elif normalized.count(",") == 1:
        left, right = normalized.split(",")
        normalized = left + right if len(right) == 3 else left + "." + right
    else:
        normalized = normalized.replace(",", "")
    try:
        return float(normalized)
    except ValueError:
        return None


def _record_match_evidence(
    field_name: str,
    match: re.Match[str],
    evidence: dict[str, list[str]],
    methods: dict[str, str],
    source: str,
) -> None:
    evidence[field_name] = [_evidence_excerpt(match.group(0))]
    methods[field_name] = f"labeled_{source}"


def extract_academic_fields(
    text: str,
    evidence: dict[str, list[str]] | None = None,
    methods: dict[str, str] | None = None,
    source: str = "pdf_text",
) -> dict[str, str | float | int | None]:
    evidence = evidence if evidence is not None else {}
    methods = methods if methods is not None else {}
    fields = empty_academic_fields()

    text_labels = (
        ("student_name", ("student name", "candidate name", "name"), 200),
        ("institution", ("institution", "school", "college", "university"), 300),
        ("qualification", ("qualification", "examination", "exam", "class"), 200),
    )
    for field_name, labels, maximum_length in text_labels:
        fields[field_name] = _label_value(
            text,
            labels,
            maximum_length,
            evidence,
            field_name,
        )
        if fields[field_name] is not None:
            methods[field_name] = f"labeled_{source}"

    marks = re.search(
        rf"(?im)^\s*(?:(?:obtained|secured)\s+)?marks?"
        rf"(?:\s+(?:obtained|secured))?\s*[:\-]\s*"
        rf"({_NUMBER_PATTERN})\s*(?:/\s*({_NUMBER_PATTERN}))?\s*$",
        text,
    )
    if marks:
        extracted_marks = _number(marks.group(1))
        extracted_maximum = _number(marks.group(2))
        if extracted_marks is not None and extracted_marks <= 1_000_000:
            if extracted_maximum is None:
                fields["marks"] = extracted_marks
                _record_match_evidence("marks", marks, evidence, methods, source)
            elif 0 < extracted_maximum <= 1_000_000 and extracted_marks <= extracted_maximum:
                fields["marks"] = extracted_marks
                fields["maximum_marks"] = extracted_maximum
                _record_match_evidence("marks", marks, evidence, methods, source)
                _record_match_evidence("maximum_marks", marks, evidence, methods, source)

    maximum_marks = re.search(
        rf"(?im)^\s*(?:maximum|max\.?)\s+marks?\s*[:\-]\s*({_NUMBER_PATTERN})\s*$",
        text,
    )
    if maximum_marks:
        extracted_maximum = _number(maximum_marks.group(1))
        if extracted_maximum is not None and 0 < extracted_maximum <= 1_000_000:
            fields["maximum_marks"] = extracted_maximum
            _record_match_evidence("maximum_marks", maximum_marks, evidence, methods, source)

    if (
        fields["marks"] is not None
        and fields["maximum_marks"] is not None
        and fields["marks"] > fields["maximum_marks"]
    ):
        fields["marks"] = None
        evidence.pop("marks", None)
        methods.pop("marks", None)

    percentage = re.search(
        rf"(?im)^\s*(?:aggregate\s+)?percentage\s*[:\-]\s*"
        rf"({_NUMBER_PATTERN})\s*%?\s*$",
        text,
    )
    if percentage:
        extracted_percentage = _number(percentage.group(1))
        if extracted_percentage is not None and extracted_percentage <= 100:
            fields["percentage"] = extracted_percentage
            _record_match_evidence("percentage", percentage, evidence, methods, source)
    if (
        fields["percentage"] is None
        and fields["marks"] is not None
        and fields["maximum_marks"] is not None
    ):
        fields["percentage"] = round(fields["marks"] / fields["maximum_marks"] * 100, 2)
        evidence["percentage"] = list(
            dict.fromkeys(evidence.get("marks", []) + evidence.get("maximum_marks", []))
        )
        methods["percentage"] = "calculated_from_marks"

    year = re.search(
        r"(?im)^\s*(?:examination|exam|passing)?\s*year\s*[:\-]\s*((?:19|20)\d{2})\s*$",
        text,
    )
    if year:
        fields["examination_year"] = int(year.group(1))
        _record_match_evidence("examination_year", year, evidence, methods, source)

    cgpa = re.search(
        rf"(?im)^\s*(?:cumulative\s+)?"
        rf"(?:c\.?\s*g\.?\s*p\.?\s*a\.?|gpa|grade\s+point\s+average)"
        rf"\s*[:\-]\s*({_NUMBER_PATTERN})(?:\s*/\s*{_NUMBER_PATTERN})?\s*$",
        text,
    )
    if cgpa:
        extracted_cgpa = _number(cgpa.group(1))
        if extracted_cgpa is not None and extracted_cgpa <= 1_000:
            fields["cgpa"] = extracted_cgpa
            _record_match_evidence("cgpa", cgpa, evidence, methods, source)
    return fields


def _extract_pdf_text(content: bytes) -> _TextExtractionResult:
    try:
        reader = PdfReader(BytesIO(content), strict=True)
        if reader.is_encrypted:
            return _TextExtractionResult(
                None,
                "encrypted_pdf",
                "Encrypted PDFs are not supported; no academic fields were extracted.",
            )
        if not reader.pages:
            raise DocumentProcessingError("PDF contains no pages.")
    except DocumentProcessingError:
        raise
    except _TEXT_EXTRACTION_ERRORS as exc:
        raise DocumentProcessingError("PDF is malformed or unreadable.") from exc

    try:
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except _TEXT_EXTRACTION_ERRORS:
        return _TextExtractionResult(
            None,
            "extraction_failed",
            "PDF text extraction failed; no academic fields were extracted.",
        )
    if not text.strip():
        return _TextExtractionResult(
            None,
            "empty_text",
            "No searchable text was found in the PDF.",
        )
    return _TextExtractionResult(text, "text_extracted")


def _validate_image(content: bytes, expected_format: str) -> None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(BytesIO(content))
            if image.format != expected_format:
                raise DocumentProcessingError("Image content does not match the detected file type.")
            image.verify()
    except DocumentProcessingError:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        ValueError,
    ) as exc:
        raise DocumentProcessingError("Image is malformed or unreadable.") from exc


def _unavailable_document(
    content_type: str,
    *,
    status: str,
    extraction_status: str,
    ocr_status: str,
    message: str,
) -> ProcessedDocument:
    return ProcessedDocument(
        content_type=content_type,
        status=status,
        extraction_status=extraction_status,
        ocr_status=ocr_status,
        extracted_fields=empty_academic_fields(),
        extraction_evidence={},
        extraction_methods={},
        warnings=[message, "Document contents are not verified."],
    )


def _process_text(
    content_type: str,
    text: str,
    *,
    source: str,
    ocr_status: str,
    extra_warnings: list[str] | None = None,
) -> ProcessedDocument:
    evidence: dict[str, list[str]] = {}
    methods: dict[str, str] = {}
    try:
        fields = extract_academic_fields(text, evidence, methods, source)
    except _TEXT_EXTRACTION_ERRORS:
        return _unavailable_document(
            content_type,
            status="extraction_failed",
            extraction_status="extraction_failed",
            ocr_status=ocr_status,
            message="Academic text extraction failed; no fields were extracted.",
        )

    has_fields = any(value is not None for value in fields.values())
    warnings_list = list(extra_warnings or [])
    warnings_list.append("Extracted information is unverified and requires student review.")
    if not has_fields:
        warnings_list.append("No supported academic fields were identified in the document text.")
    if methods.get("percentage") == "calculated_from_marks":
        warnings_list.append("Percentage was calculated from the explicitly stated marks and maximum marks.")
    return ProcessedDocument(
        content_type=content_type,
        status="review_required",
        extraction_status="fields_extracted" if has_fields else "no_supported_fields",
        ocr_status=ocr_status,
        extracted_fields=fields,
        extraction_evidence=evidence,
        extraction_methods=methods,
        warnings=warnings_list,
    )


def _process_with_ocr(
    content: bytes,
    content_type: str,
    adapter: OCRAdapter | None,
    *,
    unavailable_message: str,
) -> ProcessedDocument:
    if adapter is None:
        return _unavailable_document(
            content_type,
            status="ocr_not_configured",
            extraction_status="ocr_not_configured",
            ocr_status="not_configured",
            message=unavailable_message,
        )
    try:
        text = adapter.extract_text(content=content, content_type=content_type)
    except OCRAdapterError as exc:
        return _unavailable_document(
            content_type,
            status="extraction_failed",
            extraction_status="ocr_failed",
            ocr_status="failed",
            message=str(exc),
        )
    if not isinstance(text, str) or not text.strip():
        return _unavailable_document(
            content_type,
            status="extraction_failed",
            extraction_status="ocr_empty_text",
            ocr_status="failed",
            message="OCR returned no searchable text; no academic fields were extracted.",
        )
    return _process_text(
        content_type,
        text,
        source="ocr_text",
        ocr_status="completed",
        extra_warnings=["Fields were drafted from OCR text and require student review."],
    )


def process_document(
    filename: str,
    claimed_content_type: str | None,
    content: bytes,
    allowed_mime_types: set[str],
    ocr_adapter: OCRAdapter | None = None,
) -> ProcessedDocument:
    safe_filename = validate_filename(filename)
    if not content:
        raise DocumentProcessingError("Uploaded file is empty.")

    if content.startswith(b"%PDF-"):
        detected_type = "application/pdf"
        if len(content) < 16:
            raise DocumentProcessingError("PDF is malformed or unreadable.")
        image_format = None
    elif content.startswith(b"\x89PNG\r\n\x1a\n"):
        detected_type = "image/png"
        image_format = "PNG"
    elif content.startswith(b"\xff\xd8\xff"):
        detected_type = "image/jpeg"
        image_format = "JPEG"
    else:
        raise DocumentProcessingError(
            "File signature is not a supported PDF, JPEG, or PNG.",
            status_code=415,
        )

    if detected_type not in allowed_mime_types:
        raise DocumentProcessingError(
            "This document type is not allowed by the server configuration.",
            status_code=415,
        )
    if claimed_content_type != detected_type:
        raise DocumentProcessingError("Declared content type does not match the file signature.")
    if _MIME_BY_EXTENSION.get(PurePath(safe_filename).suffix.lower()) != detected_type:
        raise DocumentProcessingError("Filename extension does not match the detected file type.")

    if detected_type == "application/pdf":
        pdf_result = _extract_pdf_text(content)
        if pdf_result.status == "encrypted_pdf":
            return _unavailable_document(
                detected_type,
                status="extraction_failed",
                extraction_status=pdf_result.status,
                ocr_status="not_configured",
                message=pdf_result.warning or "Encrypted PDF could not be processed.",
            )
        if pdf_result.text is not None:
            return _process_text(
                detected_type,
                pdf_result.text,
                source="pdf_text",
                ocr_status="not_required",
            )
        if pdf_result.status == "extraction_failed" and ocr_adapter is None:
            return _unavailable_document(
                detected_type,
                status="extraction_failed",
                extraction_status="extraction_failed",
                ocr_status="not_configured",
                message=pdf_result.warning or "PDF text extraction failed.",
            )
        return _process_with_ocr(
            content,
            detected_type,
            ocr_adapter,
            unavailable_message=(
                "No searchable text was found. OCR is not configured."
                if pdf_result.status == "empty_text"
                else "PDF text extraction failed and OCR is not configured."
            ),
        )

    _validate_image(content, image_format)
    return _process_with_ocr(
        content,
        detected_type,
        ocr_adapter,
        unavailable_message="OCR is not configured; no academic fields were extracted from this image.",
    )
