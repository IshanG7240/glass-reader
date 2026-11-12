plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.glassreader"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.glassreader"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webassets"))
    androidResources { noCompress += listOf("woff2", "woff", "mjs", "js") }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}

// The reader itself is the desktop renderer, unchanged. It is copied in at build time
// together with the few libraries it loads, so there is one reader to maintain.
val repo = rootProject.projectDir.parentFile
val copyWeb = tasks.register<Sync>("copyWebAssets") {
    into(layout.buildDirectory.dir("webassets/web"))
    from(File(repo, "renderer")) { into("renderer") }
    from(File(repo, "samples")) { into("samples") }
    from(File(repo, "android/web")) { into("android") }
    from(File(repo, "extension/browser")) { into("android"); include("Readability.js", "background.js") }
    from(File(repo, "node_modules")) {
        into("node_modules")
        include(
            "@fontsource/literata/**", "@fontsource-variable/inter/**", "@fontsource/jetbrains-mono/**",
            "katex/dist/katex.mjs", "katex/dist/katex.min.css", "katex/dist/fonts/**",
            "pdfjs-dist/build/pdf.mjs", "pdfjs-dist/build/pdf.worker.mjs",
            "pdfjs-dist/cmaps/**", "pdfjs-dist/standard_fonts/**", "pdfjs-dist/wasm/**",
            "marked/lib/marked.esm.js",
            "mermaid/dist/mermaid.esm.min.mjs", "mermaid/dist/chunks/mermaid.esm.min/**",
            "mammoth/mammoth.browser.min.js", "jszip/dist/jszip.min.js",
        )
        exclude("**/*.map", "**/*.d.ts", "**/*.woff")
    }
}
tasks.named("preBuild") { dependsOn(copyWeb) }
