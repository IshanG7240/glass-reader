package dev.glassreader

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

/** Serves the reader (from the APK) and opened documents (from app storage) on one https origin. */
object Assets {
    const val HOST = "appassets.androidplatform.net"

    private val MIME = mapOf(
        "html" to "text/html", "htm" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript",
        "css" to "text/css", "json" to "application/json", "svg" to "image/svg+xml",
        "woff2" to "font/woff2", "woff" to "font/woff", "ttf" to "font/ttf", "otf" to "font/otf",
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp",
        "md" to "text/markdown", "markdown" to "text/markdown", "txt" to "text/plain", "pdf" to "application/pdf",
        "epub" to "application/epub+zip", "wasm" to "application/wasm",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    fun mime(name: String) = MIME[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

    fun serve(c: Context, uri: Uri): WebResourceResponse? {
        if (uri.host != HOST) return null
        val path = uri.path ?: return notFound()
        return try {
            when {
                path == "/web/renderer/index.html" -> {
                    // The Android shim must run before the reader's own script.
                    val html = c.assets.open("web/renderer/index.html").bufferedReader().readText().replace(
                        "</head>",
                        "<link rel=\"stylesheet\" href=\"../android/android.css\">\n<script src=\"../android/shim.js\"></script>\n</head>",
                    )
                    ok("text/html", ByteArrayInputStream(html.toByteArray()))
                }
                path.startsWith("/web/") -> ok(mime(path), c.assets.open(path.removePrefix("/").let(Uri::decode)))
                path == "/wall.jpg" -> {
                    val f = File(c.filesDir, "wall.jpg")
                    if (f.isFile) ok("image/jpeg", f.inputStream()) else notFound()
                }
                path.startsWith("/doc/") -> {
                    val parts = path.removePrefix("/doc/").split('/', limit = 2)
                    val f = Docs.file(c, parts[0], Uri.decode(parts.getOrElse(1) { "" }))
                    if (f != null && f.isFile) ok(mime(f.name), f.inputStream()) else notFound()
                }
                else -> notFound()
            }
        } catch (e: java.io.IOException) {
            notFound()
        }
    }

    private fun ok(mime: String, data: InputStream) = WebResourceResponse(
        mime, if (mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json")) "utf-8" else null,
        200, "OK", mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-cache"), data,
    )

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

/** Opened and captured documents, newest 40 kept: files/docs/<id>/<name>. */
object Docs {
    private const val KEEP = 40

    private fun dir(c: Context) = File(c.filesDir, "docs").apply { mkdirs() }

    fun file(c: Context, id: String, name: String): File? {
        if (!Regex("[a-z0-9]+").matches(id) || name.contains('/') || name.startsWith(".")) return null
        return File(File(dir(c), id), name)
    }

    fun write(c: Context, name: String, bytes: ByteArray): File {
        val id = java.lang.Long.toString(System.currentTimeMillis(), 36) + (100..999).random()
        val safe = name.replace(Regex("""[/\\\u0000]"""), "_").trimStart('.').ifBlank { "document" }.take(120)
        val f = File(File(dir(c), id).apply { mkdirs() }, safe)
        f.writeBytes(bytes)
        prune(c)
        return f
    }

    fun slug(title: String) = title.replace(Regex("""[^\p{L}\p{N} ._-]+"""), " ").replace(Regex("\\s+"), " ").trim().take(70).ifBlank { "Untitled" }

    private fun prune(c: Context) {
        val all = dir(c).listFiles()?.sortedByDescending { it.lastModified() } ?: return
        all.drop(KEEP).forEach { it.deleteRecursively() }
    }
}
