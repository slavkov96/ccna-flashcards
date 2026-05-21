"""Extract CCNA 3 exam questions from a saved itexamanswers.net HTML page into JSON."""

import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

QUESTION_HEADER_RE = re.compile(r"^\s*(\d+)\.\s+(.*)", re.DOTALL)
TOPIC_RE = re.compile(r"Topic\s+([\d.]+)")

AD_URL_FRAGMENTS = (
    "itexam-1.png",
    "cdn5-fstl-tf.anyclip.com",
    "googlesyndication",
    "doubleclick",
    "anyclip-player",
    "/logo/",
)


def find_question_header(p_tag):
    if p_tag.name != "p":
        return None
    lead = p_tag.find(["strong", "b"])
    if not lead:
        return None
    text = lead.get_text(" ", strip=True)
    m = QUESTION_HEADER_RE.match(text)
    if not m:
        return None
    return int(m.group(1)), m.group(2).strip()


def is_correct(li):
    for el in li.find_all(["strong", "b", "span"]):
        style = (el.get("style") or "").replace(" ", "").lower()
        if "color:#ff0000" in style or "color:red" in style:
            return True
    return False


def clean_text(node):
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


def usable_image_src(img):
    src = img.get("src") or ""
    if not src:
        return None
    if any(frag in src for frag in AD_URL_FRAGMENTS):
        return None
    return src


def first_image(bucket):
    for node in bucket:
        if not isinstance(node, Tag):
            continue
        for img in node.find_all("img"):
            src = usable_image_src(img)
            if src:
                return src
    return None


def first_pre(bucket):
    for node in bucket:
        if not isinstance(node, Tag):
            continue
        pre = node.find("pre") if node.name != "pre" else node
        if pre:
            return pre.get_text()
    return None


def first_ul(bucket, stop_at=None):
    for node in bucket:
        if node is stop_at:
            return None
        if not isinstance(node, Tag):
            continue
        if node.name == "ul":
            return node
    return None


def is_bold_only_paragraph(p):
    """True if the <p> is essentially just a <strong>/<b> wrapper (question continuation).
    Excludes paragraphs marked as correct answers (red styling)."""
    if p.name != "p":
        return False
    if is_correct(p):
        return False
    text = p.get_text(" ", strip=True)
    if not text:
        return False
    bold_text = " ".join(
        b.get_text(" ", strip=True) for b in p.find_all(["strong", "b"])
    ).strip()
    if not bold_text:
        return False
    return len(bold_text) >= len(text) * 0.8


def collect_p_options(bucket, stop_at):
    """Fallback: collect <p> siblings as options when no <ul> exists."""
    options = []
    for node in bucket:
        if node is stop_at:
            break
        if not isinstance(node, Tag) or node.name != "p":
            continue
        if node.find("img"):
            continue
        text = node.get_text(" ", strip=True)
        if not text:
            continue
        if is_bold_only_paragraph(node):
            continue
        options.append(node)
    return options


def find_explanation_div(bucket):
    for node in bucket:
        if not isinstance(node, Tag):
            continue
        if node.name == "div" and "message_box" in (node.get("class") or []) and "success" in (node.get("class") or []):
            return node
        found = node.find("div", class_=lambda c: c and "message_box" in c and "success" in c)
        if found:
            return found
    return None


def clean_explanation(div):
    div = BeautifulSoup(str(div), "lxml").find("div")
    for bad in div.select("div[id^=adngin], div[id^=google_ads], div.cbc-code-bar, script, ins"):
        bad.decompose()
    for bad in div.find_all(
        "div", class_=lambda c: c and any("92f2483bb651eed307c93e619d752c78" in cls for cls in c)
    ):
        bad.decompose()
    for strong in div.find_all(["strong", "b"]):
        text = strong.get_text(" ", strip=True)
        if text.lower().startswith("explanation"):
            nxt = strong.next_sibling
            if isinstance(nxt, NavigableString):
                stripped = re.sub(r"^[:\s]+", "", str(nxt))
                nxt.replace_with(stripped)
            strong.decompose()
            break
    html = div.decode_contents().strip()
    html = re.sub(r"^\s*<p>\s*</p>\s*", "", html)
    html = re.sub(r"\s*<p>\s*</p>\s*$", "", html)
    return html.strip()


def extract_topic(explanation_html):
    if not explanation_html:
        return None
    text = BeautifulSoup(explanation_html, "lxml").get_text(" ", strip=True)
    m = TOPIC_RE.search(text)
    return m.group(1) if m else None


def segment_questions(post_body):
    buckets = []
    current = None
    for child in post_body.children:
        if not isinstance(child, Tag):
            continue
        header = find_question_header(child)
        if header:
            number, question_text = header
            current = {"number": number, "question_text": question_text, "header_node": child, "nodes": []}
            buckets.append(current)
        elif current is not None:
            current["nodes"].append(child)
    return buckets


def extract_question(bucket):
    number = bucket["number"]
    question_text = bucket["question_text"]
    header_node = bucket["header_node"]
    nodes = bucket["nodes"]

    image = None
    for img in header_node.find_all("img"):
        src = usable_image_src(img)
        if src:
            image = src
            break
    if image is None:
        image = first_image(nodes)

    code = first_pre(nodes)

    explanation_div = find_explanation_div(nodes)

    # Merge any bold-only follow-up paragraphs into the question text
    # (these are question continuations after a code block / image).
    extra_question_parts = []
    for node in nodes:
        if node is explanation_div:
            break
        if isinstance(node, Tag) and node.name == "p" and is_bold_only_paragraph(node):
            extra_question_parts.append(node.get_text(" ", strip=True))
    if extra_question_parts:
        question_text = (question_text + " " + " ".join(extra_question_parts)).strip()

    options = []
    ul = first_ul(nodes, stop_at=explanation_div)
    if ul:
        for li in ul.find_all("li", recursive=False):
            options.append({"text": clean_text(li), "correct": is_correct(li)})
    else:
        for p in collect_p_options(nodes, stop_at=explanation_div):
            options.append({"text": clean_text(p), "correct": is_correct(p)})

    explanation_html = clean_explanation(explanation_div) if explanation_div else None
    topic = extract_topic(explanation_html)

    return {
        "number": number,
        "question": re.sub(r"\s+", " ", question_text).strip(),
        "image": image,
        "code": code,
        "options": options,
        "explanation_html": explanation_html,
        "topic": topic,
    }


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_questions.py <input.html> <output.json>", file=sys.stderr)
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    html = input_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html, "lxml")

    post_body = (
        soup.select_one("div.thecontent")
        or soup.select_one("div.post-single-content")
        or soup.select_one("div.single_post")
        or soup.body
    )
    buckets = segment_questions(post_body)
    questions = [extract_question(b) for b in buckets]

    output_path.write_text(json.dumps(questions, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Extracted {len(questions)} questions to {output_path}")


if __name__ == "__main__":
    main()
