package dev.glassreader

import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import kotlin.math.abs

class Chat(val title: String, val markdown: String)

/** One piece of text (or a marker such as "Copy code") in the chat, wherever it was seen. */
class Item(val key: String, val text: CharSequence?, val desc: String?, val cls: String, val viewId: String) {
    /** Bounds in each pass where it was on screen, by pass number. */
    val seen = LinkedHashMap<Int, Rect>()
    var inBubble = false   // inside a long-pressable bubble: what you wrote
    var inToggle = false   // inside a tap-to-expand row: tool use, "thinking" summaries
    var inHScroll = false  // inside a sideways scroller: code and tables
    var viewIdPath = ""    // resource ids of the ancestors (Gemini has them)
    var heading = false    // the app marks headings for screen readers (ChatGPT, Claude)
    var lineH = 0f         // a heading's line height (its size; the box may be two lines)

    /**
     * Gemini puts a whole section in one text view. Per line (by index): where its first
     * character was drawn (indent and size say list item, quote or heading), and the
     * width of each space (a very wide one is the gap between two table cells).
     */
    val lineStart = HashMap<Int, android.graphics.RectF>()
    val lineSpaces = HashMap<Int, List<Float?>>()
    val lines: List<String> by lazy { str.split('\n') }

    /** The tallest view of it: the one least clipped by the screen edges. */
    val box: Rect? get() = seen.values.maxByOrNull { it.height() }
    val str: String get() = text?.toString() ?: ""
    override fun toString() = "Item(${str.take(40)}${desc?.let { " desc=$it" } ?: ""} ${box})"
}

/**
 * Walks a chat from top to bottom. The apps only keep what is on screen (and a little
 * more), so the list is scrolled to the top, then forward one screen at a time; each
 * screen's text is merged into one ordered list, then turned into Markdown.
 */
class ChatReader(
    private val svc: CaptureService,
    private val pkg: String,
    private val app: String,
    private val rootOf: (String?) -> AccessibilityNodeInfo?,
    private val cancelled: () -> Boolean,
    private val progress: (String) -> Unit,
) {
    private val items = ArrayList<Item>()
    private val index = HashMap<String, Item>()
    private var pass = 0
    private var viewport = Rect()

    fun read(): Chat? {
        val t0 = SystemClock.uptimeMillis()
        fresh()
        val root = rootOf(pkg) ?: run { Log.w(TAG, "read: no window for $pkg"); return null }
        var list = findList(root) ?: run { Log.w(TAG, "read: no scrolling list in $pkg"); return null }
        val title = titleOf(root, list)
        list.getBoundsInScreen(viewport)

        // 1. To the top. Apps that load older messages as you go (Gemini) get a moment to.
        var steps = 0
        var stillAtTop = 0
        while (!cancelled() && steps < 600) {
            list = refreshList(list) ?: break
            if (can(list, AccessibilityAction.ACTION_SCROLL_BACKWARD)) {
                stillAtTop = 0
                list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
                steps++
                if (steps % 5 == 0) progress("")
                SystemClock.sleep(90)
            } else {
                if (++stillAtTop >= 3) break
                SystemClock.sleep(350)
            }
        }
        settle(list)
        Log.w(TAG, "read: cancelled=${cancelled()} list=${list.className} ${list.actionList.map { it.id }}")
        Log.w(TAG, "read: top after $steps steps, ${SystemClock.uptimeMillis() - t0} ms")

        // 2. Down, one screen at a time.
        var screens = 0
        while (!cancelled() && screens < 800) {
            list = refreshList(list) ?: run { Log.w(TAG, "read: lost the list"); null } ?: break
            snapshot(list)
            screens++
            progress("· $screens")
            if (!can(list, AccessibilityAction.ACTION_SCROLL_FORWARD)) { Log.w(TAG, "read: no forward action at screen $screens: ${list.actionList.map { it.id }}"); break }
            if (!list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) { Log.w(TAG, "read: forward refused at screen $screens"); break }
            settle(list)
        }
        Log.w(TAG, "read: $screens screens, ${items.size} items, ${SystemClock.uptimeMillis() - t0} ms")
        if (items.isEmpty()) return null
        return Formatter(app, items, title).chat()
    }

    /** Forget cached nodes: after a scroll, the cache still has the old positions. */
    private fun fresh() {
        if (android.os.Build.VERSION.SDK_INT >= 34) svc.clearCache()
    }

    private fun can(n: AccessibilityNodeInfo, a: AccessibilityAction) = n.actionList.any { it.id == a.id }

    private fun refreshList(old: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (old.refresh()) return old
        val root = rootOf(pkg)
        Log.w(TAG, "read: list went stale; root=${root != null}")
        return root?.let { findList(it) }
    }

    /** Wait until the screen stops moving after a scroll. */
    private fun settle(list: AccessibilityNodeInfo) {
        var last = ""
        val until = SystemClock.uptimeMillis() + 1500
        SystemClock.sleep(120)
        while (SystemClock.uptimeMillis() < until) {
            val sig = signature(list)
            if (sig == last) return
            last = sig
            SystemClock.sleep(110)
        }
    }

    private fun signature(list: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        val r = Rect()
        fun walk(n: AccessibilityNodeInfo?, d: Int) {
            n ?: return
            if (d > 60) return
            if (!n.text.isNullOrEmpty()) { n.getBoundsInScreen(r); sb.append(r.top).append(':').append(n.text!!.length).append(';') }
            for (i in 0 until n.childCount) walk(n.getChild(i), d + 1)
        }
        fresh()
        list.refresh()
        walk(list, 0)
        return sb.toString()
    }

    /** The conversation's name, when the app shows it in its top bar (Claude does). */
    private fun titleOf(root: AccessibilityNodeInfo, list: AccessibilityNodeInfo): String? {
        val w = svc.resources.displayMetrics.widthPixels
        val d = svc.resources.displayMetrics.density
        val r = Rect()
        var found: String? = null
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            n ?: return
            if (depth > 40 || found != null || n == list) return
            val t = n.text?.toString()?.trim()
            if (!t.isNullOrEmpty() && n.childCount == 0) {
                n.getBoundsInScreen(r)
                if (r.top < 110 * d && abs(r.centerX() - w / 2) < 60 * d && t.length in 2..120 &&
                    !Regex("(?i)^(incognito chat|temporary chat|chatgpt|claude|gemini.*|get plus|new chat)$").matches(t)) found = t
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return found
    }

    /** The chat's own scrolling list: the biggest vertically scrolling thing on screen. */
    private fun findList(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestArea = 0
        val r = Rect()
        fun walk(n: AccessibilityNodeInfo?, d: Int) {
            n ?: return
            if (d > 60) return
            val cls = n.className?.toString() ?: ""
            if (n.isScrollable && !cls.contains("Horizontal") && cls != "android.widget.EditText" && !cls.contains("ViewPager")) {
                n.getBoundsInScreen(r)
                val vertical = n.actionList.any { it.id == android.R.id.accessibilityActionScrollDown || it.id == android.R.id.accessibilityActionScrollUp } ||
                    n.collectionInfo?.let { it.rowCount != 1 || it.columnCount <= 1 } ?: true
                val area = r.width() * r.height()
                if (vertical && area > bestArea && r.height() > root.let { Rect().also { x -> it.getBoundsInScreen(x) }.height() / 3 }) { best = n; bestArea = area }
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), d + 1)
        }
        walk(root, 0)
        return best
    }

    /** What is on screen now, merged into the running list in reading order. */
    private fun snapshot(list: AccessibilityNodeInfo) {
        pass++
        val found = ArrayList<Pair<Item, Rect>>()
        val r = Rect()
        fun walk(n: AccessibilityNodeInfo?, d: Int, bubble: Boolean, toggle: Boolean, hscroll: Boolean, ids: String) {
            n ?: return
            if (d > 80) return
            val cls = n.className?.toString() ?: ""
            val id = n.viewIdResourceName?.substringAfterLast('/') ?: ""
            val text = n.text
            val desc = n.contentDescription?.toString()
            val b = bubble || (n.isLongClickable && !n.isScrollable)
            val t = toggle || (n.isClickable && !n.isLongClickable && n.childCount > 0)
            val h = hscroll || (n.isScrollable && cls.contains("Horizontal"))
            val path = if (id.isNotEmpty() && !id.contains("obfuscated")) "$ids/$id" else ids
            if (!text.isNullOrBlank() || (!desc.isNullOrBlank() && (n.isClickable || desc in MARKERS))) {
                n.getBoundsInScreen(r)
                if (n.isVisibleToUser && r.height() > 0 && r.width() > 0) {
                    // Gemini's list recycles its views, so the same section can come back in a
                    // different view: its pieces are known by their text instead.
                    val key = if (id.startsWith("assistant_robin")) "$id|${text?.toString()?.hashCode()}"
                        else "${n.hashCode()}|${text?.toString()?.hashCode()}|${desc}"
                    val it = index[key] ?: Item(key, text, desc, cls, id).also { x ->
                        x.inBubble = bubble; x.inToggle = toggle; x.inHScroll = h; x.viewIdPath = path
                        x.heading = n.isHeading
                    }
                    if (h) it.inHScroll = true
                    if (id == "assistant_robin_text" && (it.lineStart.size < it.lines.size || h && it.lineSpaces.values.any { w -> null in w })) measureLines(n, it)
                    if (it.heading && it.lineH == 0f) it.lineH = CharBoxes.of(n, 1)?.firstOrNull()?.height() ?: -1f
                    found.add(it to Rect(r))
                }
            }
            if (text.isNullOrBlank() || n.childCount > 0) {
                for (i in 0 until n.childCount) walk(n.getChild(i), d + 1, b, t, h, path)
            }
        }
        fresh()
        list.refresh()
        walk(list, 0, false, false, false, "")

        // Reading order on screen: rows top to bottom (things within a few pixels share a
        // row, such as a list number and its text, or a table's cells), left to right.
        val rows = found.sortedBy { it.second.top }
        val ordered = ArrayList<Pair<Item, Rect>>()
        var i = 0
        while (i < rows.size) {
            val top = rows[i].second.top
            var j = i
            while (j < rows.size && rows[j].second.top - top <= 12) j++
            ordered.addAll(rows.subList(i, j).sortedBy { it.second.left })
            i = j
        }

        Log.w(TAG, "read: pass $pass found ${found.size}: " + ordered.take(6).joinToString(" | ") { "${it.first.str.take(20)}@${it.second.top}" })
        // Merge: new items go right after the last one already known.
        val firstKnown = ordered.indexOfFirst { index.containsKey(it.first.key) }
        var at = if (firstKnown < 0) items.size else items.indexOf(index[ordered[firstKnown].first.key])
        for ((k, pair) in ordered.withIndex()) {
            val (it, rect) = pair
            it.seen[pass] = rect
            val known = index[it.key]
            if (known != null) { at = items.indexOf(known) + 1; continue }
            if (firstKnown >= 0 && k < firstKnown) {
                items.add(at, it); at++
            } else {
                at = at.coerceIn(0, items.size)
                items.add(at, it); at++
            }
            index[it.key] = it
        }
    }

    /** Gemini: record where each line of a section starts, for the lines on screen now. */
    private fun measureLines(n: AccessibilityNodeInfo, it: Item) {
        val boxes = CharBoxes.of(n) ?: return
        val text = it.str
        var start = 0
        for ((k, line) in it.lines.withIndex()) {
            val end = start + line.length
            if (!it.lineStart.containsKey(k)) {
                val first = (start until end).firstOrNull { i -> text[i] != '\u200b' && !text[i].isWhitespace() }
                val r = first?.let { i -> boxes.getOrNull(i) }
                if (r != null && r.height() > 0) it.lineStart[k] = r
            }
            // Space widths (table cells): keep what was measured, fill in what wasn't on screen.
            val now = (start until end).filter { i -> text[i] == ' ' }.map { i -> boxes.getOrNull(i)?.width() }
            val had = it.lineSpaces[k]
            if (now.any { w -> w != null }) it.lineSpaces[k] = if (had == null) now else had.mapIndexed { j, w -> w ?: now.getOrNull(j) }
            start = end + 1
        }
    }

    companion object {
        const val TAG = "GlassReader"
        val MARKERS = setOf("Code block", "Copy code", "Expand code", "Copy", "Copy message")
    }
}
