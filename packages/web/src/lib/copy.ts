/**
 * Copying to the clipboard (M11.13).
 *
 * `navigator.clipboard` is not always there. The desktop app's WKWebView does not expose the async
 * clipboard API at all, and a browser denies it outside a secure context — so a helper that only
 * calls `writeText` silently does nothing in exactly the shell most people run this in. That was a
 * real shipped bug (fixed in 0.12.1) and this is the fallback that fixed it.
 *
 * Returns whether it worked, so a caller that shows feedback can tell the truth about it.
 */
export async function copyText(text: string | null | undefined): Promise<boolean> {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission denied or an insecure context — fall through to the textarea.
  }
  try {
    const scratch = document.createElement("textarea");
    scratch.value = value;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}
