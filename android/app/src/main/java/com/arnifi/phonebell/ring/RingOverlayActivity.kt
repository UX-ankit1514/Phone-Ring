package com.arnifi.phonebell.ring

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.arnifi.phonebell.R
import com.arnifi.phonebell.notifications.RequestActionReceiver

/**
 * The full-screen caller card shown while the phone is ringing, so whoever is nearby can
 * see *who* needs the phone without unlocking it.
 *
 * It is reached three ways, and tolerates all of them: a direct launch from [RingService],
 * the notification's full-screen intent on a locked screen, and a tap on the notification.
 * The screen closes when the request is acknowledged here, acknowledged from the
 * notification, cancelled by the requester, or simply expires.
 */
class RingOverlayActivity : ComponentActivity() {
    private var requestId: String? = null
    private var requester by mutableStateOf(RingService.DEFAULT_REQUESTER)

    private val handler = Handler(Looper.getMainLooper())
    private val closeAtExpiry = Runnable { finishAndRemoveTask() }
    private var receiverRegistered = false

    private val dismissReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.getStringExtra(RingService.EXTRA_REQUEST_ID) == requestId) finishAndRemoveTask()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockedScreen()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        readRequest(intent)
        ContextCompat.registerReceiver(
            this,
            dismissReceiver,
            IntentFilter(ACTION_DISMISS_OVERLAY),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiverRegistered = true
        setContent { IncomingRequestOverlay(requester = requester, onAcknowledge = ::acknowledge) }
    }

    /** Wakes the phone and shows the caller over the lock screen, on every supported release. */
    private fun showOverLockedScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
    }

    /** A second request arriving while this screen is up re-targets it instead of stacking. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readRequest(intent)
    }

    override fun onDestroy() {
        handler.removeCallbacks(closeAtExpiry)
        if (receiverRegistered) {
            unregisterReceiver(dismissReceiver)
            receiverRegistered = false
        }
        super.onDestroy()
    }

    private fun readRequest(intent: Intent) {
        requestId = intent.getStringExtra(RingService.EXTRA_REQUEST_ID)
        requester = intent.getStringExtra(RingService.EXTRA_REQUESTER)
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?: RingService.DEFAULT_REQUESTER
        val expiresAt = intent.getLongExtra(
            RingService.EXTRA_EXPIRES_AT,
            System.currentTimeMillis() + DEFAULT_DURATION_MS,
        )
        // A safety net only: the service normally closes this screen when it stops ringing.
        handler.removeCallbacks(closeAtExpiry)
        handler.postDelayed(closeAtExpiry, (expiresAt - System.currentTimeMillis()).coerceAtLeast(1L))
    }

    private fun acknowledge() {
        requestId?.let { id ->
            sendBroadcast(
                Intent(this, RequestActionReceiver::class.java)
                    .setAction(RequestActionReceiver.ACTION_ACKNOWLEDGE)
                    .putExtra(RequestActionReceiver.EXTRA_REQUEST_ID, id),
            )
        }
        finishAndRemoveTask()
    }

    companion object {
        const val ACTION_DISMISS_OVERLAY = "com.arnifi.phonebell.action.DISMISS_RING_OVERLAY"

        private const val DEFAULT_DURATION_MS = 10_000L

        fun createIntent(
            context: Context,
            requestId: String,
            requester: String,
            expiresAtEpochMs: Long,
        ): Intent = Intent(context, RingOverlayActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(RingService.EXTRA_REQUEST_ID, requestId)
            .putExtra(RingService.EXTRA_REQUESTER, requester)
            .putExtra(RingService.EXTRA_EXPIRES_AT, expiresAtEpochMs)

        /** Closes the screen showing [requestId], and only that one. */
        fun dismissIntent(packageName: String, requestId: String): Intent =
            Intent(ACTION_DISMISS_OVERLAY)
                .setPackage(packageName)
                .putExtra(RingService.EXTRA_REQUEST_ID, requestId)
    }
}

@Composable
private fun IncomingRequestOverlay(requester: String, onAcknowledge: () -> Unit) {
    MaterialTheme {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(SCRIM)
                .padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(32.dp),
                colors = CardDefaults.cardColors(containerColor = CARD),
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 28.dp, vertical = 36.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    Image(
                        painter = painterResource(R.drawable.ic_phone_bell),
                        contentDescription = null,
                        modifier = Modifier.size(72.dp),
                    )
                    Text(
                        text = stringResource(R.string.incoming_phone_request),
                        color = ACCENT,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = stringResource(R.string.requester_needs_phone, requester),
                        color = INK,
                        fontSize = 34.sp,
                        fontWeight = FontWeight.Bold,
                        lineHeight = 40.sp,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        text = stringResource(R.string.ringing_at_max_volume),
                        color = MUTED_INK,
                        fontSize = 16.sp,
                        textAlign = TextAlign.Center,
                    )
                    Button(
                        onClick = onAcknowledge,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(18.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = SIGNAL, contentColor = INK),
                    ) {
                        Text(
                            text = stringResource(R.string.ive_got_it),
                            modifier = Modifier.padding(vertical = 8.dp),
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }
    }
}

private val SCRIM = Color(0xB3001516)
private val CARD = Color(0xFFF4F7F2)
private val ACCENT = Color(0xFF006C5B)
private val INK = Color(0xFF071F21)
private val MUTED_INK = Color(0xFF506163)
private val SIGNAL = Color(0xFFB9FF38)
