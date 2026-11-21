import json
import mimetypes
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"
ORIGIN = "https://shop.example.invalid"
PNG = (PUBLIC / "art-001-1.jpg").read_bytes()

DISPLAY_ONLY = {
    "stable_id": "art-001",
    "available_quantity": None,
    "sale_ready": False,
    "published_revision": {"snapshot": {
        "title": "Display artwork",
        "description": "Visible without a price or cart button.",
        "category": "Devotional art",
        "base_price_cents": None,
        "width_eighths": None,
        "height_eighths": None,
        "offered_for_sale": False,
        "photos": [{"asset_id": "legacy_a", "url": "/art-001-1.jpg", "alt": "Display artwork", "position": 0, "is_main": True}],
        "configurations": [],
    }},
}

SALE = {
    "stable_id": "art-010",
    "available_quantity": 1,
    "sale_ready": True,
    "published_revision": {"snapshot": {
        "title": "Sale-ready artwork",
        "description": "A server-backed sale fixture.",
        "category": "Decorative art",
        "base_price_cents": 10000,
        "width_eighths": 99,
        "height_eighths": 80,
        "offered_for_sale": True,
        "photos": [{"asset_id": "legacy_b", "url": "/art-001-1.jpg", "alt": "Sale artwork", "position": 0, "is_main": True}],
        "configurations": [{"id": "frame_a", "label": "Unframed", "enabled": True, "price_add_on_cents": 0, "packing_profile_id": "pack_a"}],
    }},
}


def browser_path():
    return Path.home() / "AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe"


def serve(route):
    request = route.request
    parsed = urlsplit(request.url)
    path = parsed.path
    if path == "/api/catalog":
        route.fulfill(status=200, json={"items": [DISPLAY_ONLY, SALE], "pagination": {"page": 1, "pages": 1, "total": 2, "from": 1, "to": 2}, "facets": {"categories": ["Devotional art", "Decorative art"]}})
        return
    if path == "/api/cart/quote":
        body = request.post_data_json
        assert body["items"] == [{"artwork_id": "art-010", "configuration_id": "frame_a", "quantity": 1}]
        route.fulfill(status=200, json={
            "quote_id": "incomplete_quote",
            "lines": [{"artwork_id": "art-010", "configuration_id": "frame_a", "title": "Sale-ready artwork", "configuration_label": "Unframed", "quantity": 1, "unit_price_cents": 10000, "line_total_cents": 10000}],
            "merchandise_subtotal_cents": 10000,
            "shipping_cents": None,
            "handling_cents": None,
            "tax_cents": None,
            "grand_total_cents": None,
            "checkout_enabled": False,
            "missing_setup": ["Shipping quote required", "Checkout not yet available"],
        })
        return
    if path == "/":
        path = "/index.html"
    file = (PUBLIC / path.lstrip("/")).resolve()
    if PUBLIC not in file.parents or not file.is_file():
        route.fulfill(status=404)
        return
    mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    route.fulfill(status=200, content_type=mime, body=file.read_bytes())


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(browser_path()))
        context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        context.route("**/*", serve)
        page.goto(ORIGIN + "/")
        page.locator(".gallery-card").first.wait_for()
        assert page.locator(".gallery-card").count() == 2
        assert page.locator("#art-001").get_by_text("Display only", exact=True).count() >= 1
        assert page.get_by_role("button", name="Add to cart").count() == 1
        page.get_by_role("button", name="Add to cart").click()
        assert page.locator(".cart-count").first.inner_text() == "1"
        stored = page.evaluate("JSON.parse(localStorage.getItem('nyahsark.cart.v1'))")
        assert stored == [{"artwork_id": "art-010", "configuration_id": "frame_a", "quantity": 1}]
        page.goto(ORIGIN + "/cart.html")
        page.get_by_text("Current merchandise prices and availability checked.").wait_for()
        assert page.locator("#subtotal").inner_text() == "$100.00"
        assert page.locator("#shipping").inner_text() == "Shipping quote required"
        assert page.locator("#checkout").is_disabled()
        assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        assert not errors, errors
        desktop = browser.new_context(viewport={"width": 1280, "height": 900})
        desktop.route("**/*", serve)
        wide = desktop.new_page()
        wide.goto(ORIGIN + "/")
        wide.locator(".gallery-card").first.wait_for()
        assert wide.locator(".gallery-card").count() == 2
        assert wide.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
        desktop.close()
        browser.close()
        print(json.dumps({"pass": True, "viewports": ["390x844 touch", "1280x900 desktop"], "checks": ["dynamic catalog", "display-only visibility", "configuration price", "cart refs only", "server quote", "null shipping/tax", "disabled checkout", "no horizontal overflow"]}))


if __name__ == "__main__":
    main()
