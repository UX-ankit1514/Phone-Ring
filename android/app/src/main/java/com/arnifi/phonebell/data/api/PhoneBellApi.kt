package com.arnifi.phonebell.data.api

import com.arnifi.phonebell.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

fun interface IdTokenProvider {
    suspend fun getIdToken(): String?
}

class ApiException(
    val statusCode: Int,
    override val message: String,
) : IOException(message) {
    val isRetryable: Boolean get() = statusCode == 0 || statusCode == 408 || statusCode == 429 || statusCode >= 500
}

class PhoneBellApi(
    private val baseUrl: String,
    private val idTokenProvider: IdTokenProvider,
    private val client: OkHttpClient = defaultClient(),
) {
    suspend fun enroll(enrollmentCode: String): String {
        val body = JSONObject()
            .put("deviceId", BuildConfig.TARGET_DEVICE_ID)
            .put("enrollmentCode", enrollmentCode)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("deviceModel", android.os.Build.MODEL)
        val response = post("devices/enroll", body, requiresAuth = false)
        val data = response.optJSONObject("data")
        return response.optString("customToken")
            .ifBlank { response.optString("firebaseCustomToken") }
            .ifBlank { data?.optString("customToken").orEmpty() }
            .ifBlank { data?.optString("firebaseCustomToken").orEmpty() }
            .ifBlank { throw ApiException(200, "Enrollment response did not contain a custom token") }
    }

    suspend fun registerDevice(fcmToken: String) {
        post(
            "devices/register",
            JSONObject()
                .put("deviceId", BuildConfig.TARGET_DEVICE_ID)
                .put("fcmToken", fcmToken)
                .put("appVersion", BuildConfig.VERSION_NAME)
                .put("deviceModel", android.os.Build.MODEL)
                .put("capabilities", JSONObject()
                    .put("ring", true)
                    .put("vibration", true)
                    .put("tts", false)),
        )
    }

    suspend fun delivered(requestId: String) {
        post(
            "phone-requests/${requestId.pathSegment()}/delivered",
            JSONObject().put("deviceId", BuildConfig.TARGET_DEVICE_ID),
        )
    }

    suspend fun acknowledge(requestId: String) {
        post(
            "phone-requests/${requestId.pathSegment()}/acknowledge",
            JSONObject().put("deviceId", BuildConfig.TARGET_DEVICE_ID),
        )
    }

    suspend fun heartbeat() {
        post(
            "devices/heartbeat",
            JSONObject()
                .put("deviceId", BuildConfig.TARGET_DEVICE_ID)
                .put("appVersion", BuildConfig.VERSION_NAME),
        )
    }

    private suspend fun post(path: String, body: JSONObject, requiresAuth: Boolean = true): JSONObject =
        withContext(Dispatchers.IO) {
            val url = baseUrl.ensureTrailingSlash() + path
            val requestBuilder = Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                .header("Accept", "application/json")

            if (requiresAuth) {
                val idToken = idTokenProvider.getIdToken()
                    ?: throw ApiException(401, "Target device is not enrolled")
                requestBuilder.header("Authorization", "Bearer $idToken")
            }

            val response = try {
                client.newCall(requestBuilder.build()).execute()
            } catch (error: IOException) {
                throw ApiException(0, error.message ?: "Network request failed")
            }

            response.use {
                val responseText = it.body?.string().orEmpty()
                if (!it.isSuccessful) {
                    val safeMessage = runCatching {
                        val error = JSONObject(responseText).optJSONObject("error")
                        error?.optString("message").orEmpty().ifBlank {
                            JSONObject(responseText).optString("message").ifBlank { "Request failed" }
                        }
                    }.getOrDefault("Request failed")
                    throw ApiException(it.code, safeMessage)
                }
                if (responseText.isBlank()) return@use JSONObject()
                val parsed = runCatching { JSONObject(responseText) }
                    .getOrElse { throw ApiException(response.code, "Server returned invalid JSON") }
                // Every backend route uses the { success, ... } envelope. Keep the
                // envelope intact so callers can safely read route-specific fields.
                if (parsed.optBoolean("success", true).not()) {
                    val error = parsed.optJSONObject("error")
                    throw ApiException(
                        it.code,
                        error?.optString("message").orEmpty().ifBlank { "Request failed" },
                    )
                }
                parsed
            }
        }

    private fun String.ensureTrailingSlash(): String = if (endsWith('/')) this else "$this/"

    private fun String.pathSegment(): String {
        require(REQUEST_ID_REGEX.matches(this)) { "Invalid request ID" }
        return this
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val REQUEST_ID_REGEX = Regex("^[A-Za-z0-9_-]{1,128}$")

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .writeTimeout(8, TimeUnit.SECONDS)
            .callTimeout(12, TimeUnit.SECONDS)
            .build()
    }
}
