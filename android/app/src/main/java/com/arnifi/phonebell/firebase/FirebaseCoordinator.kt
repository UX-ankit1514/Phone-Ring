package com.arnifi.phonebell.firebase

import android.content.Context
import com.arnifi.phonebell.BuildConfig
import com.arnifi.phonebell.data.api.IdTokenProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.tasks.await

class FirebaseCoordinator(private val context: Context) : IdTokenProvider {
    val isConfigured: Boolean
        get() = BuildConfig.FIREBASE_PROJECT_ID.isNotBlank() &&
            BuildConfig.FIREBASE_APPLICATION_ID.isNotBlank() &&
            BuildConfig.FIREBASE_API_KEY.isNotBlank() &&
            BuildConfig.FIREBASE_GCM_SENDER_ID.isNotBlank()

    fun initialize(): Boolean {
        if (!isConfigured) return false
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setGcmSenderId(BuildConfig.FIREBASE_GCM_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(context, options)
        }
        return true
    }

    fun isEnrolled(): Boolean = isConfigured && FirebaseAuth.getInstance().currentUser != null

    suspend fun enroll(customToken: String) {
        require(isConfigured) { "Firebase is not configured for this build" }
        FirebaseAuth.getInstance().signInWithCustomToken(customToken).await()
    }

    override suspend fun getIdToken(): String? {
        if (!isConfigured) return null
        return FirebaseAuth.getInstance().currentUser?.getIdToken(false)?.await()?.token
    }
}
