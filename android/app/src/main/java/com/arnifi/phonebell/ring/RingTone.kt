package com.arnifi.phonebell.ring

import android.content.Context
import android.media.RingtoneManager
import android.net.Uri
import android.provider.Settings
import androidx.core.net.toUri
import com.arnifi.phonebell.R

/**
 * Chooses what the phone actually plays when a request arrives.
 *
 * The bell is the handset's own ringtone — the Samsung tone this phone is set to — so the
 * alert sounds like the device it lives on, and follows any later change in Settings without
 * a new build. The tone is read off the phone at ring time; nothing copyrighted is bundled
 * into the APK or redistributed with it.
 *
 * [BUNDLED_BELL] stays as the fallback for the one case the phone cannot supply a tone: a
 * ringtone set to Silent, or a tone this app is not allowed to read. That keeps a shared
 * office phone audible even when its ringtone has been switched off.
 */
internal object RingTone {
    /** The phone's current ringtone, resolved afresh on every ring, or null when it has none. */
    fun deviceRingtone(context: Context): Uri? = runCatching {
        RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
    }.getOrNull()

    /** The bell shipped with the app, which always plays. */
    fun bundledBell(context: Context): Uri =
        "android.resource://${context.packageName}/${R.raw.phone_bell}".toUri()

    /**
     * The sound for the notification channel used by the fallback alert path.
     *
     * A channel's sound is frozen when the channel is created, so a concrete media URI would
     * pin the bell to whichever tone was set on the day of install. This symbolic URI is
     * resolved at playback instead, which keeps the fallback following the phone's ringtone.
     */
    fun channelSound(): Uri = Settings.System.DEFAULT_RINGTONE_URI

    /** What Diagnostics shows, so whoever sets the phone up can confirm the bell before it matters. */
    fun describe(context: Context): String = runCatching {
        deviceRingtone(context)
            ?.let { RingtoneManager.getRingtone(context, it)?.getTitle(context) }
            ?: BUNDLED_BELL
    }.getOrNull() ?: BUNDLED_BELL

    private const val BUNDLED_BELL = "built-in bell"
}
