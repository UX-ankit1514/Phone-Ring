package com.arnifi.phonebell.ui

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.arnifi.phonebell.ArnifiPhoneBellApp
import com.arnifi.phonebell.model.DiagnosticsSnapshot

class MainActivity : ComponentActivity() {
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        val vm = MainViewModel(application as ArnifiPhoneBellApp)
        setContent { PhoneBellApp(vm) }
    }
}

@Composable
private fun PhoneBellApp(vm: MainViewModel) {
    val diagnostics by vm.diagnostics.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    var showDiagnostics by remember { mutableStateOf(false) }
    MaterialTheme {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("UAE Phone Bell", style = MaterialTheme.typography.headlineMedium)
                Text("Shared calling phone", style = MaterialTheme.typography.bodyLarge)
                if (!diagnostics.enrolled) EnrollmentCard(vm, diagnostics, busy)
                else HomeCard(vm, diagnostics, busy)
                message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
                HorizontalDivider()
                TextButton(onClick = { showDiagnostics = !showDiagnostics }) { Text(if (showDiagnostics) "Hide diagnostics" else "Diagnostics") }
                if (showDiagnostics) DiagnosticsCard(diagnostics)
            }
        }
    }
}

@Composable
private fun EnrollmentCard(vm: MainViewModel, diagnostics: DiagnosticsSnapshot, busy: Boolean) {
    var code by remember { mutableStateOf("") }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Enroll this phone", style = MaterialTheme.typography.titleLarge)
            Text("Enter the one-time code provided by your admin.")
            OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("Enrollment code") }, visualTransformation = PasswordVisualTransformation())
            Button(
                onClick = { vm.enroll(code) },
                enabled = !busy && diagnostics.firebaseConfigured && code.trim().length >= 6,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Enrolling…" else "Enroll phone") }
            if (!diagnostics.firebaseConfigured) Text("Firebase configuration is missing for this build.", color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun HomeCard(vm: MainViewModel, diagnostics: DiagnosticsSnapshot, busy: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Ready for calls", style = MaterialTheme.typography.titleLarge)
            Text("Keep notifications and sound enabled. Incoming requests ring this phone until you acknowledge them.")
            Button(onClick = vm::testRing, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text("TEST RING")
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { vm.retryTokenRegistration() }, enabled = !busy) { Text("Sync notifications") }
            }
        }
    }
}

@Composable
private fun DiagnosticsCard(snapshot: DiagnosticsSnapshot) {
    val context = LocalContext.current
    val notificationManager = context.getSystemService(NotificationManager::class.java)
    val channel = notificationManager.getNotificationChannel(com.arnifi.phonebell.ring.RingService.CHANNEL_ID)
    val notificationsReady = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE)
    val audio = context.getSystemService(AudioManager::class.java)
    val dndActive = notificationManager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL
    val silentMode = audio.ringerMode == AudioManager.RINGER_MODE_SILENT
    val audioReady = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) > 0 && !silentMode && !dndActive
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val network = connectivity.activeNetwork
    val internetReady = network != null && connectivity.getNetworkCapabilities(network)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Diagnostics", style = MaterialTheme.typography.titleLarge)
            Text("Environment: ${com.arnifi.phonebell.BuildConfig.ENVIRONMENT}")
            Text("Firebase: ${if (snapshot.firebaseConfigured) "configured" else "not configured"}")
            Text("Enrollment: ${if (snapshot.enrolled) "complete" else "required"}")
            Text("FCM token: ${if (snapshot.tokenRegistered) "registered" else "not registered"}")
            Text("Notifications: ${if (notificationsReady) "ready" else "needs attention"}")
            Text("Internet: ${if (internetReady) "connected" else "offline"}")
            Text("Audio: ${if (audioReady) "ready" else "suppressed by volume, Silent, or Do Not Disturb"}")
            Text("Do Not Disturb: ${if (dndActive) "active — alerts stay quiet" else "off"}")
            Text("Device: ${com.arnifi.phonebell.BuildConfig.TARGET_DEVICE_ID}")
            Text("App version: ${com.arnifi.phonebell.BuildConfig.VERSION_NAME}")
            snapshot.lastRequestId?.let { Text("Last request: $it (${snapshot.lastRequestStatus ?: "unknown"})") }
            snapshot.lastRequesterName?.let { Text("Last requester: $it") }
            snapshot.lastFcmAtEpochMs?.let { Text("Last FCM: ${java.util.Date(it)}") }
            snapshot.lastHeartbeatAtEpochMs?.let { Text("Last heartbeat: ${java.util.Date(it)}") }
            snapshot.lastError?.let { Text("Last error: $it", color = MaterialTheme.colorScheme.error) }
            TextButton(onClick = {
                context.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                )
            }) { Text("Open notification settings") }
        }
    }
}
