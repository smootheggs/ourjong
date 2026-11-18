plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "app.ourjong"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.ourjong"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        manifestPlaceholders["appLabel"] = "Ourjong"
    }

    // Signed with your private key from the SLOTH_KEYSTORE_* secrets, so only you can publish an
    // update that installs over it. Without the secrets, CI builds the debug APK.
    val releaseKeystore = System.getenv("SLOTH_KEYSTORE")?.let { file(it) }?.takeIf { it.isFile }

    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storeType = "pkcs12"
                storePassword = System.getenv("SLOTH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SLOTH_KEY_ALIAS") ?: "slothllama"
                keyPassword = System.getenv("SLOTH_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            isMinifyEnabled = false
            isShrinkResources = false
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["appLabel"] = "Ourjong Dev"
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        checkReleaseBuilds = false
    }
}

// The game itself: the web build (apps/client/dist) goes in assets/www. CI puts it there; a
// build without it would make an empty app, so it stops instead.
val checkGame = tasks.register("checkGameAssets") {
    val index = file("src/main/assets/www/index.html")
    doLast {
        check(index.isFile) {
            "The web game is missing: build apps/client with OURJONG_APK=1 and copy dist/ to android/app/src/main/assets/www"
        }
    }
}
tasks.named("preBuild") { dependsOn(checkGame) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
}
