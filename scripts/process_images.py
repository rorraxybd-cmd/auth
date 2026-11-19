import os
from io import BytesIO
import numpy as np
import requests
from PIL import Image, ImageEnhance, ImageFilter
from rembg import remove

REELS_W, REELS_H = 1080, 1920


def enhance_and_rim(rgba_img: Image.Image) -> Image.Image:
    rgba_img = rgba_img.convert("RGBA")
    arr = np.array(rgba_img, dtype=np.float32)
    alpha = arr[:, :, 3]
    mask = alpha > 20

    if not np.any(mask):
        return rgba_img

    rgb = arr[:, :, :3]
    avg_brightness = rgb[mask].mean()

    pil_rgb = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB")

    # কালো বা খুব ডার্ক প্রোডাক্ট হলে বাড়তি ডিটেইল ও সূক্ষ্ম রিম-গ্লো
    if avg_brightness < 65:
        pil_rgb = ImageEnhance.Brightness(pil_rgb).enhance(1.18)
        pil_rgb = ImageEnhance.Contrast(pil_rgb).enhance(1.22)
        pil_rgb = ImageEnhance.Sharpness(pil_rgb).enhance(1.25)

        alpha_img = Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L")
        dilated = alpha_img.filter(ImageFilter.MaxFilter(7))
        rim_mask = np.clip(np.array(dilated, dtype=np.float32) - alpha, 0, 255)
        rim_blur = Image.fromarray(rim_mask.astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=2.5)
        )

        rim_layer = Image.new("RGBA", rgba_img.size, (220, 210, 190, 0))
        rim_alpha = (np.array(rim_blur, dtype=np.float32) * 0.45).astype(np.uint8)
        rim_layer.putalpha(Image.fromarray(rim_alpha, mode="L"))

        clean_prod = pil_rgb.convert("RGBA")
        clean_prod.putalpha(Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L"))
        return Image.alpha_composite(rim_layer, clean_prod)

    # সাধারণ প্রোডাক্টের জন্য ক্লিন ব্রাইটনেস, কন্ট্রাস্ট ও শার্পনেস
    pil_rgb = ImageEnhance.Brightness(pil_rgb).enhance(1.10)
    pil_rgb = ImageEnhance.Contrast(pil_rgb).enhance(1.15)
    pil_rgb = ImageEnhance.Sharpness(pil_rgb).enhance(1.20)

    out = pil_rgb.convert("RGBA")
    out.putalpha(Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L"))
    return out


def to_reels_9_16(prod_rgba: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (REELS_W, REELS_H), (0, 0, 0, 255))
    img = prod_rgba.copy()
    img.thumbnail((int(REELS_W * 0.82), int(REELS_H * 0.65)), Image.Resampling.LANCZOS)

    pos_x = (REELS_W - img.width) // 2
    pos_y = (REELS_H - img.height) // 2
    canvas.paste(img, (pos_x, pos_y), img)
    return canvas.convert("RGB")


def main():
    raw_urls = os.environ.get("IMAGE_URLS", "")
    product_id = os.environ.get("PRODUCT_ID", "prod").strip() or "prod"
    urls = [u.strip() for u in raw_urls.split(",") if u.strip().startswith("http")]

    os.makedirs("output", exist_ok=True)

    for idx, url in enumerate(urls, start=1):
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            cutout = Image.open(BytesIO(remove(resp.content))).convert("RGBA")
            enhanced = enhance_and_rim(cutout)
            reels_img = to_reels_9_16(enhanced)

            out_path = os.path.join("output", f"{product_id}_{idx}.webp")
            reels_img.save(out_path, "WEBP", quality=82, method=6)
            print(f"Saved: {out_path}")
        except Exception as e:
            print(f"Failed for {url}: {e}")


if __name__ == "__main__":
    main()
