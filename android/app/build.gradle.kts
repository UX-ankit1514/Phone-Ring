import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val arnifiLocalProperties = Properties().apply {
    rootProject.file("firebase.properties").takeIf { it.isFile }?.inputStream()?.use(::load)
}

fun stringProperty(name: String, fallback: String = ""): String =
    providers.gradleProperty(name).orNull?.takeIf { it.isNotBlank() }
        ?: arnifiLocalProperties.getProperty(name, fallback)

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val releaseSigningPropertyNames = listOf(
    "ARNIFI_KEYSTORE_PATH",
    "ARNIFI_KEYSTORE_PASSWORD",
    "ARNIFI_KEY_ALIAS",
    "ARNIFI_KEY_PASSWORD",
)
val hasReleaseSigning = releaseSigningPropertyNames.all {
    stringProperty(it).isNotBlank()
}

android {
    namespace = "com.arnifi.phonebell"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.arnifi.phonebell"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "TARGET_DEVICE_ID", quoted("uae-phone-01"))
        buildConfigField("int", "DEFAULT_RING_DURATION_SECONDS", "10")
    }

    flavorDimensions += "environment"
    productFlavors {
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            manifestPlaceholders["allowCleartext"] = "true"
            resValue("string", "app_name", "Arnifi Phone Bell (Dev)")
            buildConfigField("String", "ENVIRONMENT", quoted("dev"))
            buildConfigField("String", "API_BASE_URL", quoted(stringProperty("ARNIFI_DEV_API_BASE_URL")))
            buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(stringProperty("ARNIFI_DEV_FIREBASE_PROJECT_ID")))
            buildConfigField("String", "FIREBASE_APPLICATION_ID", quoted(stringProperty("ARNIFI_DEV_FIREBASE_APPLICATION_ID")))
            buildConfigField("String", "FIREBASE_API_KEY", quoted(stringProperty("ARNIFI_DEV_FIREBASE_API_KEY")))
            buildConfigField("String", "FIREBASE_GCM_SENDER_ID", quoted(stringProperty("ARNIFI_DEV_FIREBASE_GCM_SENDER_ID")))
        }
        create("prod") {
            dimension = "environment"
            manifestPlaceholders["allowCleartext"] = "false"
            resValue("string", "app_name", "Arnifi Phone Bell")
            buildConfigField("String", "ENVIRONMENT", quoted("prod"))
            buildConfigField("String", "API_BASE_URL", quoted(stringProperty("ARNIFI_PROD_API_BASE_URL")))
            buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(stringProperty("ARNIFI_PROD_FIREBASE_PROJECT_ID")))
            buildConfigField("String", "FIREBASE_APPLICATION_ID", quoted(stringProperty("ARNIFI_PROD_FIREBASE_APPLICATION_ID")))
            buildConfigField("String", "FIREBASE_API_KEY", quoted(stringProperty("ARNIFI_PROD_FIREBASE_API_KEY")))
            buildConfigField("String", "FIREBASE_GCM_SENDER_ID", quoted(stringProperty("ARNIFI_PROD_FIREBASE_GCM_SENDER_ID")))
        }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(stringProperty("ARNIFI_KEYSTORE_PATH"))
                storePassword = stringProperty("ARNIFI_KEYSTORE_PASSWORD")
                keyAlias = stringProperty("ARNIFI_KEY_ALIAS")
                keyPassword = stringProperty("ARNIFI_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    // Compose 1.12 requires compileSdk 37. Pin the latest BOM line compatible
    // with the PRD-approved API 36 target until that runtime upgrade is tested.
    val composeBom = platform("androidx.compose:compose-bom:2025.08.01")
    val firebaseBom = platform("com.google.firebase:firebase-bom:34.18.0")

    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation(firebaseBom)

    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-messaging")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("org.robolectric:robolectric:4.16")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.work:work-testing:2.11.2")
}
