package com.arnifi.phonebell.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.arnifi.phonebell.ArnifiPhoneBellApp
import java.util.concurrent.TimeUnit

object PhoneBellWorkScheduler {
    private const val HEARTBEAT = "phone-bell-heartbeat"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
            .setInitialDelay(15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            HEARTBEAT,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun enqueueCallback(context: Context, requestId: String, action: CallbackAction) {
        val request = OneTimeWorkRequestBuilder<CallbackWorker>()
            .setInputData(CallbackWorker.input(requestId, action))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "phone-bell-callback-$requestId-${action.name.lowercase()}",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun enqueueTokenRegistration(context: Context, token: String) {
        val request = OneTimeWorkRequestBuilder<TokenRegistrationWorker>()
            .setInputData(androidx.work.workDataOf(TokenRegistrationWorker.KEY_TOKEN to token))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("phone-bell-token-registration", ExistingWorkPolicy.REPLACE, request)
    }
}

enum class CallbackAction { DELIVERED, ACKNOWLEDGE }

class HeartbeatWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as ArnifiPhoneBellApp
        if (!app.repository.isEnrolled) return Result.success()
        return runCatching { app.repository.heartbeat(); Result.success() }
            .getOrElse { app.settings.recordError(it.message ?: "Heartbeat failed"); if (runAttemptCount < 3) Result.retry() else Result.failure() }
    }
}

class CallbackWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val requestId = inputData.getString(KEY_REQUEST_ID) ?: return Result.failure()
        val action = inputData.getString(KEY_ACTION)?.let { runCatching { CallbackAction.valueOf(it) }.getOrNull() }
            ?: return Result.failure()
        val app = applicationContext as ArnifiPhoneBellApp
        if (!app.repository.isEnrolled) return Result.retry()
        return runCatching {
            when (action) {
                CallbackAction.DELIVERED -> app.repository.delivered(requestId)
                CallbackAction.ACKNOWLEDGE -> app.repository.acknowledge(requestId)
            }
            Result.success()
        }.getOrElse { app.settings.recordError(it.message ?: "Callback failed"); if (runAttemptCount < 4) Result.retry() else Result.failure() }
    }

    companion object {
        private const val KEY_REQUEST_ID = "request_id"
        private const val KEY_ACTION = "action"
        fun input(requestId: String, action: CallbackAction) = androidx.work.workDataOf(
            KEY_REQUEST_ID to requestId,
            KEY_ACTION to action.name,
        )
    }
}

class TokenRegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val token = inputData.getString(KEY_TOKEN) ?: return Result.failure()
        val app = applicationContext as ArnifiPhoneBellApp
        if (!app.repository.isEnrolled) return Result.success()
        return runCatching { app.repository.registerToken(token); Result.success() }
            .getOrElse { app.settings.recordError(it.message ?: "Token registration failed"); if (runAttemptCount < 4) Result.retry() else Result.failure() }
    }

    companion object { const val KEY_TOKEN = "fcm_token" }
}
