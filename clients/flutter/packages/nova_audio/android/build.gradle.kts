group = "com.nova.nova_audio"
version = "0.1.0"
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
val aoqSdk = file("../Vendor/AoqClientSdk-release.aar")
android {
    namespace = "com.nova.nova_audio"
    compileSdk = 36
    defaultConfig { minSdk = 24; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets {
        getByName("main").java.srcDirs("src/main/kotlin", if (aoqSdk.exists()) "src/aoq/kotlin" else "src/noaoq/kotlin")
        getByName("test").java.srcDirs("src/test/kotlin")
    }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
dependencies {
    if (aoqSdk.exists()) implementation(files(aoqSdk))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
}
tasks.withType<Test>().configureEach {
    systemProperty("nova.fixtures", rootProject.file("../../../fixtures/client-protocol/v1/vectors.json").absolutePath)
}
