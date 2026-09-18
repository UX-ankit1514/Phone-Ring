package com.arnifi.phonebell.ring

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.audiofx.LoudnessEnhancer

/**
 * Owns every temporary audio change made while an urgent phone request is ringing:
 * exclusive audio focus, the alarm stream pinned to maximum, and the extra gain that
 * carries the bell across a room the way a system SOS alarm does.
 *
 * Each step is best-effort. An OEM that refuses one of them must still leave the phone
 * ringing, just slightly quieter, so no failure here is allowed to escape.
 */
internal class RingAudioSession(private val audioManager: AudioManager) {
    private var previousAlarmVolume: Int? = null
    private var focusRequest: AudioFocusRequest? = null
    private var loudnessEnhancer: LoudnessEnhancer? = null

    /**
     * Takes over the alarm stream at full volume. Safe to call more than once: the very
     * first volume observed is the one [end] restores, so a repeated call can never
     * record maximum as the user's own setting.
     */
    fun begin(attributes: AudioAttributes) {
        if (previousAlarmVolume == null) {
            previousAlarmVolume = runCatching {
                audioManager.getStreamVolume(AudioManager.STREAM_ALARM)
            }.getOrNull()
        }
        runCatching {
            audioManager.setStreamVolume(
                AudioManager.STREAM_ALARM,
                audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM),
                0,
            )
        }
        if (focusRequest == null) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener { /* The alert stays authoritative for its short life. */ }
                .build()
                .also { request -> runCatching { audioManager.requestAudioFocus(request) } }
        }
    }

    /**
     * Adds post-mixer gain to [audioSessionId] so the bell still reads as urgent on phones
     * whose maximum alarm volume is conservative. Call it once the player exists; [end]
     * releases the effect before the player is torn down.
     */
    fun amplify(audioSessionId: Int) {
        // Session id 0 is the global output mix; boosting that would amplify every app.
        if (loudnessEnhancer != null || audioSessionId <= 0) return
        loudnessEnhancer = runCatching {
            LoudnessEnhancer(audioSessionId).apply {
                setTargetGain(TARGET_GAIN_MILLIBELS)
                enabled = true
            }
        }.getOrNull()
    }

    /** Undoes everything [begin] and [amplify] changed. A no-op when nothing was changed. */
    fun end() {
        loudnessEnhancer?.let { enhancer ->
            runCatching {
                enhancer.enabled = false
                enhancer.release()
            }
        }
        loudnessEnhancer = null
        previousAlarmVolume?.let { previous ->
            runCatching {
                audioManager.setStreamVolume(
                    AudioManager.STREAM_ALARM,
                    previous.coerceIn(0, audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM)),
                    0,
                )
            }
        }
        previousAlarmVolume = null
        focusRequest?.let { request -> runCatching { audioManager.abandonAudioFocusRequest(request) } }
        focusRequest = null
    }

    private companion object {
        /** 9 dB of headroom: audibly louder in a room, short of the clipping that muddies the bell. */
        const val TARGET_GAIN_MILLIBELS = 900
    }
}
