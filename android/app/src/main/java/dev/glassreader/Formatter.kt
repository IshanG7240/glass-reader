package dev.glassreader

import android.text.Spanned
import android.text.style.StyleSpan
import android.text.style.URLSpan
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Turns what was on screen back into Markdown, in the same shape as the desktop's chat
 * documents (each prompt a heading, the answer below it).
 *
 * ChatGPT and Claude draw each Markdown block as its own piece of text, and the layout
 * says what it was: the app marks headings, an indented piece after "1." or "•" is a list
 * item, pieces side by side are a table row, text after a language label and "Copy code"
 * is code, and text in a long-pressable bubble is what you wrote.
 *
 * Gemini puts a whole section in one piece of text, one paragraph per line: where each
 * line starts says list item or paragraph, very wide spaces separate table cells, and
 * formulas are the parts its spoken description reads differently.
 */
class Formatter(private val app: String, private val items: List<Item>, private val chatTitle: String?) {
    private val density = android.content.res.Resources.getSystem().displayMetrics.density
    private fun dp(px: Number) = px.toFloat() / density

    class Turn(var prompt: String = "", val blocks: ArrayList<String> = ArrayList())

    fun chat(): Chat? {
        val turns = (if (app == "Gemini") gemini() else compose()).onEach { joinLists(it) }
        val answered = turns.count { it.blocks.isNotEmpty() }
        if (turns.isEmpty() || answered == 0 && turns.all { it.prompt.isBlank() }) return null
        val first = turns.firstOrNull { it.prompt.isNotBlank() }?.prompt?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim() ?: "$app chat"
        val title = chatTitle ?: if (first.length > 80) first.take(79).trimEnd() + "…" else first
        val out = StringBuilder()
        out.append("# ").append(title).append("\n\n*").append(app).append(" · ").append(answered)
            .append(if (answered == 1) " answer" else " answers").append("*\n\n")
        turns.forEachIndexed { i, t ->
            val line = t.prompt.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: ""
            val head = if (line.length > 120) line.take(119) + "…" else line.ifBlank { "$app’s answer" }
            if (i > 0) out.append("---\n\n")
            out.append("<h2 id=\"gr-turn-${i + 1}\">").append(esc(head)).append("</h2>\n\n")
            if (t.prompt.replace(Regex("\\s+"), " ").length > head.length + 2) {
                out.append(t.prompt.lines().joinToString("\n") { "> $it" }).append("\n\n")
            }
            for (b in t.blocks) out.append(b).append("\n\n")
        }
        return Chat(title, out.toString())
    }

    // ---------- ChatGPT and Claude ----------

    private fun compose(): List<Turn> {
        val turns = ArrayList<Turn>()
        val answer = items.filter { !it.inBubble && !it.inToggle && it.text != null && it.box != null }
        // The answer's left edge: where most of its text starts.
        val base = answer.groupingBy { it.box!!.left }.eachCount().maxByOrNull { it.value }?.key ?: 0
        // Heading levels by size: the biggest is ###, the next ####, …
        val headSizes = answer.filter { it.heading }.map { lineHeight(it) }.distinct().sortedDescending()

        var cur: Turn? = null
        fun turn(): Turn = cur ?: Turn().also { cur = it; turns.add(it) }
        var lang: String? = null
        var codeNext = false
        val listLefts = ArrayList<Int>()
        var marker: Item? = null

        var i = 0
        while (i < items.size) {
            val it = items[i]
            val b = it.box
            val text = clean(it.str)
            when {
                it.text == null -> {
                    // Buttons. "Copy code" follows the code block's language label.
                    if ((it.desc == "Copy code" || it.desc == "Expand code") && !codeNext) {
                        val t = cur
                        val last = t?.blocks?.lastOrNull()
                        if (t != null && last != null && Regex("""^[\w+#.\- ]{1,24}$""").matches(last)) {
                            t.blocks.removeAt(t.blocks.size - 1)
                            lang = last.trim().lowercase()
                        }
                        codeNext = true
                    }
                }
                it.inToggle || isNoise(text) -> {}
                it.inBubble -> {
                    // What you wrote. Several pieces in a row are one message.
                    val t = cur
                    if (t != null && t.blocks.isEmpty() && t.prompt.isNotEmpty() && i > 0 && items[i - 1].inBubble) t.prompt += "\n\n" + text
                    else { cur = Turn(prompt = text.trim()); turns.add(cur!!) }
                    listLefts.clear(); codeNext = false; lang = null; marker = null
                }
                b == null -> {}
                codeNext -> {
                    turn().blocks.add(fence(it.str.trimEnd(), lang ?: ""))
                    codeNext = false; lang = null; listLefts.clear()
                }
                // A code block's language label: a short word just before "Copy code".
                isCodeLabel(i) -> { lang = text.trim().lowercase(); codeNext = true }
                isMarker(text) && i + 1 < items.size && sameRow(it, items[i + 1]) -> marker = it
                else -> {
                    // A table: this piece and the ones beside it, row after row.
                    if (marker == null) {
                        val rows = tableFrom(i)
                        if (rows != null) {
                            turn().blocks.add(table(rows))
                            listLefts.clear()
                            i += rows.sumOf { r -> r.size }
                            continue
                        }
                    }
                    val m = marker
                    marker = null
                    val md = inline(it)
                    val indent = dp(b.left - base)
                    when {
                        it.heading -> {
                            listLefts.clear()
                            val level = 3 + headSizes.indexOf(lineHeight(it)).coerceIn(0, 2)
                            turn().blocks.add("#".repeat(level) + " " + md.replace('\n', ' '))
                        }
                        m != null || indent >= 26 -> {
                            // A list item; deeper indents are nested lists.
                            val left = b.left
                            while (listLefts.isNotEmpty() && left < listLefts.last() - 8) listLefts.removeAt(listLefts.size - 1)
                            if (listLefts.isEmpty() || left > listLefts.last() + 8) listLefts.add(left)
                            val pad = "   ".repeat(listLefts.size - 1)
                            val mk = m?.str?.trim()?.let { mt -> if (mt.first().isDigit()) mt.trimEnd(')', '.') + "." else "-" } ?: "-"
                            turn().blocks.add(pad + mk + " " + md.replace("\n", "\n$pad   "))
                        }
                        indent >= 8 -> {
                            listLefts.clear()
                            turn().blocks.add(md.lines().joinToString("\n") { l -> "> $l" })
                        }
                        else -> {
                            listLefts.clear()
                            turn().blocks.add(escapeStart(md))
                        }
                    }
                }
            }
            i++
        }
        return turns
    }

    private fun isCodeLabel(i: Int): Boolean {
        if (!Regex("""^[\w+#.\- ]{1,24}$""").matches(items[i].str.trim())) return false
        val next = items.getOrNull(i + 1) ?: return false
        return next.text == null && (next.desc == "Copy code" || next.desc == "Expand code")
    }

    private val headBoxes by lazy { items.filter { it.heading && it.box != null }.map { it.box!!.height().toFloat() } }

    /** A heading's size. A heading that wrapped is twice as tall as one of its size that didn't. */
    private fun lineHeight(it: Item): Int {
        var h = if (it.lineH > 0) it.lineH else it.box?.height()?.toFloat() ?: 0f
        if (it.lineH <= 0) for (k in 4 downTo 2) {
            if (headBoxes.any { g -> abs(h / k - g) <= g * 0.06f }) { h /= k; break }
        }
        return (h / 4f).roundToInt()
    }

    private fun isMarker(s: String) = Regex("""^\s*(\d{1,3}[.)]|[a-zA-Z][.)]|[ivx]{1,4}[.)]|[•◦▪▫‣∙·○■□–-])\s*$""").matches(s)

    /** Footers the apps put under answers. */
    private fun isNoise(s: String) = s.length < 90 && Regex("(?i)can make mistakes|check important info|AI-generated").containsMatchIn(s)

    /** Pieces that were on screen together, side by side (a table row). */
    private fun sameRow(a: Item, b: Item): Boolean {
        for ((p, ra) in a.seen) {
            val rb = b.seen[p] ?: continue
            if (abs(ra.top - rb.top) <= 12 && rb.left > ra.left) return true
        }
        return false
    }

    private fun rowFrom(i: Int): List<Item> {
        val row = arrayListOf(items[i])
        var j = i + 1
        while (j < items.size && items[j].text != null && !items[j].inBubble && !items[j].heading &&
            !isMarker(items[j - 1].str) && sameRow(items[j - 1], items[j])) { row.add(items[j]); j++ }
        return row
    }

    /** Two or more rows of two or more cells, starting at item i. */
    private fun tableFrom(i: Int): List<List<Item>>? {
        if (items[i].heading || items[i].inBubble) return null
        val rows = ArrayList<List<Item>>()
        var j = i
        while (j < items.size) {
            val r = rowFrom(j)
            if (r.size < 2 || r.any { it.str.length > 300 }) break
            rows.add(r); j += r.size
        }
        return if (rows.size >= 2) rows else null
    }

    private fun table(rows: List<List<Item>>): String {
        // Columns by position (the widest row sets them); a missing cell stays empty.
        val cols = rows.maxByOrNull { it.size }!!.map { it.box!!.left }
        return mdTable(rows.map { r ->
            val out = MutableList(cols.size) { "" }
            for (c in r) {
                val k = cols.indices.minByOrNull { abs(cols[it] - c.box!!.left) }!!
                out[k] = (out[k] + " " + inline(c).replace('\n', ' ')).trim()
            }
            out
        })
    }

    // ---------- Gemini ----------

    /** Where Gemini's paragraphs start: list items and quotes start further right. */
    private val geminiBase by lazy {
        items.flatMap { it.lineStart.values }.groupingBy { r -> r.left.roundToInt() }.eachCount().maxByOrNull { e -> e.value }?.key?.toFloat() ?: 0f
    }

    private fun gemini(): List<Turn> {
        val turns = ArrayList<Turn>()
        var cur: Turn? = null
        fun turn(): Turn = cur ?: Turn().also { cur = it; turns.add(it) }
        var lang = ""
        for (it in items) {
            if (it.text == null || it.viewIdPath.contains("disclaimer")) continue
            when (it.viewId) {
                "assistant_robin_user_message_text" -> { cur = Turn(prompt = clean(it.str).trim()); turns.add(cur!!) }
                "assistant_robin_code_info" -> lang = it.str.trim().lowercase()
                "assistant_robin_code_impl" -> { turn().blocks.add(fence(it.str.trimEnd(), lang)); lang = "" }
                "assistant_robin_latex_text" -> turn().blocks.add(math(it.str.trim(), true))
                "assistant_robin_text" -> {
                    val table = if (it.inHScroll) geminiTable(it) else null
                    if (table != null) turn().blocks.add(table) else turn().blocks.addAll(geminiLines(it))
                }
            }
        }
        return turns
    }

    /** One block per line of a Gemini section. */
    private fun geminiLines(it: Item): List<String> {
        val out = ArrayList<String>()
        val withMath = withMath(inline(it, keepMarks = true), it.desc)
        val mathLines = withMath.split('\n')
        val known = it.lineStart.values
        val bodyH = known.map { r -> r.height() }.sorted().let { h -> if (h.isEmpty()) 0f else h[h.size / 2] }
        for ((k, raw) in it.lines.withIndex()) {
            val para = raw.startsWith('\u200b')
            val md = clean(mathLines.getOrElse(k) { raw }).trim()
            if (md.isEmpty()) continue
            val r = it.lineStart[k]
            val indent = r?.let { dp(it.left - geminiBase) } ?: 0f
            when {
                // Headings are the lines Gemini doesn't start with an invisible mark.
                !para && md.length < 120 && !Regex("[.!?:;,]$").matches(md.takeLast(1)) && !md.contains("data-math") ->
                    out.add((if (r != null && bodyH > 0 && r.height() < bodyH * 0.7f) "####" else "###") + " " + md)
                indent >= 26 -> {
                    val level = ((indent - 26) / 38).toInt().coerceIn(0, 4)
                    out.add("   ".repeat(level) + "- " + md)
                }
                indent >= 8 -> out.add("> $md")
                else -> out.add(escapeStart(md))
            }
        }
        return out
    }

    /** Gemini tables come as one line per row; very wide spaces separate the cells. */
    private fun geminiTable(it: Item): String? {
        val rows = ArrayList<List<String>>()
        for ((k, line) in it.lines.withIndex()) {
            val widths = it.lineSpaces[k] ?: return null
            val cells = ArrayList<String>()
            val sb = StringBuilder()
            var s = 0
            for (ch in line) {
                if (ch == ' ') {
                    val w = widths.getOrNull(s++)
                    // A wide space is a gap between cells; none (0) is a line break inside a
                    // cell; one that was never on screen is taken as an ordinary space.
                    if (w != null && dp(w) > 11) { cells.add(sb.toString()); sb.clear(); continue }
                }
                sb.append(ch)
            }
            cells.add(sb.toString())
            rows.add(cells.map { c -> clean(c).trim() })
        }
        if (rows.size < 2 || rows.all { r -> r.size < 2 }) return null
        val n = rows.maxOf { r -> r.size }
        return mdTable(rows.map { r -> r + List(n - r.size) { "" } })
    }

    /**
     * Gemini writes formulas as LaTeX in the text, and reads them aloud in its description
     * ("T sub cold"). Where the two differ is a formula: drawn as math in the reader.
     */
    private fun withMath(text: String, desc: String?): String {
        if (desc.isNullOrBlank() || desc == text || !text.contains(Regex("""\\[a-zA-Z]+|[_^]\{|[_^][A-Za-z0-9]"""))) return text
        val a = tokens(text)
        val b = tokens(desc)
        // Longest common subsequence of words; text words outside it are the formulas.
        val n = a.size; val m = b.size
        if (n.toLong() * m > 4_000_000) return text
        val dp = Array(n + 1) { IntArray(m + 1) }
        for (x in n - 1 downTo 0) for (y in m - 1 downTo 0)
            dp[x][y] = if (a[x].trim() == b[y].trim()) dp[x + 1][y + 1] + 1 else maxOf(dp[x + 1][y], dp[x][y + 1])
        val keep = BooleanArray(n)
        var x = 0; var y = 0
        while (x < n && y < m) {
            when {
                a[x].trim() == b[y].trim() -> { keep[x] = true; x++; y++ }
                dp[x + 1][y] >= dp[x][y + 1] -> x++
                else -> y++
            }
        }
        val sb = StringBuilder()
        var k = 0
        while (k < n) {
            if (keep[k] || a[k].isBlank()) { sb.append(a[k]); k++; continue }
            var e = k
            val run = StringBuilder()
            while (e < n && (!keep[e] || a[e].isBlank())) { run.append(a[e]); e++ }
            // Trailing spaces belong to the text around the formula.
            val raw = run.toString()
            val core = raw.trimEnd()
            val tail = raw.substring(core.length)
            if (Regex("""\\[a-zA-Z]+|[_^]""").containsMatchIn(core)) {
                // Brackets and punctuation around a formula stay outside it.
                val m2 = Regex("""^([(\[“"']*)(.*?)([)\]”"'.,;:!?]*)$""", RegexOption.DOT_MATCHES_ALL).find(core)!!
                val (pre, tex, post) = m2.destructured
                sb.append(pre).append(math(tex.removeSurrounding("**").removeSurrounding("*"), false)).append(post).append(tail)
            } else sb.append(raw)
            k = e
        }
        return sb.toString()
    }

    private fun tokens(s: String): List<String> = Regex("""\S+|\s+""").findAll(s).map { it.value }.toList()

    private fun math(tex: String, display: Boolean): String {
        val t = esc(tex)
        return if (display) "<p><span data-math=\"$t\" data-display=\"1\">$t</span></p>"
        else "<span data-math=\"$t\" data-display=\"0\">$t</span>"
    }

    // ---------- shared ----------

    /** Bold and links, where the app passes them on (Claude marks bold; ChatGPT doesn't). */
    private fun inline(it: Item, keepMarks: Boolean = false): String {
        val t = it.text ?: return ""
        val fin = { x: String -> if (keepMarks) x.replace("\u00a0", " ") else clean(x) }
        if (t !is Spanned) return fin(t.toString())
        val opens = HashMap<Int, StringBuilder>()
        val closes = HashMap<Int, StringBuilder>()
        for (s in t.getSpans(0, t.length, Any::class.java)) {
            var a = t.getSpanStart(s); var e = t.getSpanEnd(s)
            // "** text**" is not bold in Markdown: spaces stay outside the marks.
            while (a < e && (t[a].isWhitespace() || t[a] == '\u200b')) a++
            while (e > a && t[e - 1].isWhitespace()) e--
            if (a >= e) continue
            val (o, c) = when {
                s is URLSpan && s.url.startsWith("http") -> "[" to "](${s.url})"
                s is StyleSpan && s.style == android.graphics.Typeface.ITALIC && t.substring(a, e).isNotBlank() -> "*" to "*"
                // Compose (Claude) marks bold with a plain style span; Gemini uses the same
                // for formulas, and doesn't pass its bold on.
                s is StyleSpan && s.style == android.graphics.Typeface.NORMAL && app == "Gemini" -> continue
                s is StyleSpan && (e - a < t.length || t.length < 60) && t.substring(a, e).isNotBlank() && !t.substring(a, e).contains('\n') -> "**" to "**"
                else -> continue
            }
            opens.getOrPut(a) { StringBuilder() }.append(o)
            closes.getOrPut(e) { StringBuilder() }.insert(0, c)
        }
        val sb = StringBuilder()
        val s = t.toString()
        for (k in 0..s.length) {
            closes[k]?.let { sb.append(it) }
            opens[k]?.let { sb.append(it) }
            if (k < s.length) sb.append(s[k])
        }
        return fin(sb.toString())
    }

    /** Invisible marks and icon placeholders the apps leave in their text. */
    private fun clean(s: String) = s.replace(Regex("[\u200b\u2060\ufffc\u00ad]"), "").replace("\u00a0", " ")

    /** A paragraph that happens to start like Markdown syntax ("1. ", "- ", "#") stays a paragraph. */
    private fun escapeStart(s: String) = s.replace(Regex("""^(\d+)([.)])(\s)"""), "$1\\\\$2$3").replace(Regex("""^([-+*#>])(\s)"""), "\\\\$1$2")

    private fun mdTable(rows: List<List<String>>): String {
        val n = rows.maxOf { it.size }
        val sb = StringBuilder()
        rows.forEachIndexed { k, r ->
            sb.append("| ").append((r + List(n - r.size) { "" }).joinToString(" | ") { it.replace("|", "\\|") }).append(" |\n")
            if (k == 0) sb.append("|").append(" --- |".repeat(n)).append("\n")
        }
        return sb.toString().trimEnd()
    }

    /** Consecutive list items are one list: no blank line between them. */
    private fun joinLists(t: Turn) {
        val merged = ArrayList<String>()
        val item = Regex("""^\s*(-|\d+\.) """)
        for (blk in t.blocks) {
            val prev = merged.lastOrNull()
            if (prev != null && item.containsMatchIn(prev.lines().first()) && item.containsMatchIn(blk.lines().first())) merged[merged.size - 1] = prev + "\n" + blk
            else merged.add(blk)
        }
        t.blocks.clear(); t.blocks.addAll(merged)
    }

    private fun fence(code: String, lang: String): String {
        val n = maxOf(3, (Regex("`{3,}").findAll(code).maxOfOrNull { it.value.length } ?: 0) + 1)
        val f = "`".repeat(n)
        return "$f$lang\n$code\n$f"
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
}
