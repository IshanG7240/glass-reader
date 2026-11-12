package dev.glassreader

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.io.File

class Captured(val file: File, val chat: Boolean)

/**
 * Reads a web page the way the desktop browser extension does: the page is opened in a
 * hidden WebView and the extension's own extract() runs in it. That covers ChatGPT,
 * Claude and Gemini share links (the whole conversation) and articles (Readability).
 */
class LinkCapture(
    private val c: Context,
    private val parent: ViewGroup,
    private val url: String,
    private val done: (Result<Captured>) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var gen = 0
    private var finished = false

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        val w = WebView(c)
        web = w
        w.alpha = 0f
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.addJavascriptInterface(Js(), "GRLink")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, u: String) {
                if (finished || u.startsWith("about:")) return
                val g = ++gen
                Log.d(ReaderActivity.TAG, "link: loaded $u, reading (#$g)")
                val readability = c.assets.open("web/android/Readability.js").bufferedReader().readText()
                view.evaluateJavascript("$readability\n;window.Readability = Readability;", null)
                view.evaluateJavascript(script(g), null)
            }
        }
        parent.addView(w, 0, FrameLayout.LayoutParams(-1, -1))
        w.loadUrl(url)
        main.postDelayed({ fail("The page took too long to load.") }, 45_000)
    }

    fun cancel() {
        finished = true
        cleanup()
    }

    private fun cleanup() {
        main.removeCallbacksAndMessages(null)
        web?.let { parent.removeView(it); it.destroy() }
        web = null
    }

    private fun fail(msg: String) = main.post {
        if (finished) return@post
        finished = true
        cleanup()
        done(Result.failure(Exception(msg)))
    }

    private fun succeed(json: String) = main.post {
        if (finished) return@post
        finished = true
        cleanup()
        done(runCatching { save(JSONObject(json)) })
    }

    inner class Js {
        @JavascriptInterface fun done(g: Int, json: String) { if (g == gen) succeed(json) }
        @JavascriptInterface fun fail(g: Int, msg: String) { if (g == gen) this@LinkCapture.fail(msg) }
    }

    private fun script(g: Int): String {
        return """
            (async () => {
              try {
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const chatSel = '[data-message-author-role], [data-testid="user-message"], .font-claude-response, .font-claude-message, user-query, model-response';
                const chatSite = /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)$/.test(location.hostname);
                for (let i = 0; i < 50; i++) {
                  if (chatSite ? document.querySelector(chatSel) : document.readyState === 'complete') break;
                  await sleep(400);
                }
                await sleep(chatSite ? 1500 : 700);
                const r = await (${extractSource()})();
                if (!r || r.error) return GRLink.fail($g, (r && r.error) || 'Nothing to read on that page.');
                GRLink.done($g, JSON.stringify(r));
              } catch (e) { GRLink.fail($g, 'Couldn’t read that page (' + (e && e.message || e) + ').'); }
            })();
        """.trimIndent()
    }

    /** extract() from the browser extension: top-level, so it ends at the first unindented "}". */
    private fun extractSource(): String {
        val s = c.assets.open("web/android/background.js").bufferedReader().readText()
        val a = s.indexOf("async function extract() {")
        val b = s.indexOf("\n}\n", a)
        check(a >= 0 && b > a) { "extract() not found" }
        return s.substring(a, b + 2)
    }

    /** The extension's result as a document, the same way the desktop writes it. */
    private fun save(r: JSONObject): Captured {
        val kind = r.optString("kind")
        val title = r.optString("title").ifBlank { "Untitled" }
        val content = r.optString("content")
        val pageUrl = r.optString("url", url)
        val ext: String
        val body: String
        when (kind) {
            "markdown" -> {
                ext = "md"
                body = if (Regex("""^\s*#\s""", RegexOption.MULTILINE).containsMatchIn(content.lines().take(8).joinToString("\n"))) content
                else "# $title\n\n$content"
            }
            "code" -> {
                ext = "md"
                val fence = "`".repeat(maxOf(3, (Regex("`{3,}").findAll(content).maxOfOrNull { it.value.length } ?: 0) + 1))
                body = "# $title\n\n$fence${r.optString("lang")}\n${content.trimEnd('\n')}\n$fence\n"
            }
            "text" -> { ext = "txt"; body = content }
            "html" -> {
                ext = "html"
                val meta = listOf(r.optString("byline"), r.optString("site").ifBlank { r.optString("chat") })
                    .filter { it.isNotBlank() }.joinToString(" · ") { esc(it) }
                val host = pageUrl.replace(Regex("^https?://(www\\.)?"), "").replace(Regex("[?#].*$"), "")
                body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>${esc(title)}</title></head><body><article>" +
                    "<h1>${esc(title)}</h1>${if (meta.isNotEmpty()) "<p><em>$meta</em></p>" else ""}$content" +
                    "<p><em>From <a href=\"${esc(pageUrl)}\">${esc(host)}</a></em></p></article></body></html>"
            }
            else -> throw Exception("Glass Reader can’t show this kind of page yet.")
        }
        val chat = r.has("chat") || content.contains("gr-turn-")
        return Captured(Docs.write(c, Docs.slug(title) + "." + ext, body.toByteArray()), chat)
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
}
