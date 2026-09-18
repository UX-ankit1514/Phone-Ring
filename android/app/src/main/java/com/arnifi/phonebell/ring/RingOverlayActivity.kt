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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
                .padding(horizontal = CARD_MARGIN),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(CARD_SHAPE)
                    .background(ARNIQUE_100)
                    .border(CARD_BORDER, ARNIQUE_200, CARD_SHAPE)
                    .padding(horizontal = CARD_PADDING)
                    .padding(top = 48.dp, bottom = 30.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                BrandLockup()
                Spacer(Modifier.height(53.84.dp))
                Text(
                    text = stringResource(R.string.overlay_incoming_request),
                    color = ARNIQUE_1000,
                    fontSize = 20.sp,
                    lineHeight = 24.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.height(15.dp))
                Text(
                    text = stringResource(R.string.requester_needs_phone, requester),
                    color = ARNIQUE_1000,
                    fontSize = 30.sp,
                    lineHeight = 36.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(54.dp))
                AcknowledgeButton(onAcknowledge)
            }
        }
    }
}

/** The Arnifi wordmark and call glyph heading the card. */
@Composable
private fun BrandLockup() {
    Row(
        // Pinned to the design's height rather than left to the glyphs, so the gap
        // down to the heading stays exactly as drawn whatever the font scale does.
        modifier = Modifier.height(40.16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Image(
                painter = painterResource(R.drawable.ic_arnifi_star),
                contentDescription = null,
                modifier = Modifier.size(27.dp),
            )
            Text(
                text = stringResource(R.string.brand_arnifi),
                color = ARNIFI_INK,
                fontSize = 28.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        Image(
            painter = painterResource(R.drawable.ic_call_bulk),
            contentDescription = null,
            modifier = Modifier.size(34.dp),
        )
    }
}

@Composable
private fun AcknowledgeButton(onAcknowledge: () -> Unit) {
    Button(
        onClick = onAcknowledge,
        modifier = Modifier
            .fillMaxWidth()
            .height(68.dp),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(CARD_BORDER, ARNIQUE_300),
        colors = ButtonDefaults.buttonColors(
            containerColor = ARNIQUE_800,
            contentColor = ARNIQUE_200,
        ),
        contentPadding = PaddingValues(0.dp),
    ) {
        Text(
            text = stringResource(R.string.ive_got_it),
            fontSize = 22.sp,
            lineHeight = 27.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

// Card geometry from the design: a 342dp card inset 24dp inside a 390dp frame,
// holding 287dp of content. Expressed as margin and padding rather than fixed
// widths so the proportions hold on a narrower or wider handset, and so a long
// requester name grows the card downwards instead of being clipped by it.
private val CARD_MARGIN = 24.dp
private val CARD_PADDING = 27.5.dp
private val CARD_BORDER = 1.dp
private val CARD_SHAPE = RoundedCornerShape(20.dp)

// Arnique palette.
private val ARNIQUE_100 = Color(0xFFF5F5FF)
private val ARNIQUE_200 = Color(0xFFEBEBFF)
private val ARNIQUE_300 = Color(0xFFD6D6FF)
private val ARNIQUE_800 = Color(0xFF4646B8)
private val ARNIQUE_1000 = Color(0xFF16167A)
private val ARNIFI_INK = Color(0xFF2E2EA3)

// Not in the design, which shows the card on its own: this screen floats over
// whatever the phone was doing, so the card needs something to sit against.
private val SCRIM = Color(0xB30B0B1F)
