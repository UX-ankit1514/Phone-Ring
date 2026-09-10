package com.arnifi.phonebell

import android.app.Application
import androidx.work.Configuration
import com.arnifi.phonebell.data.api.PhoneBellApi
import com.arnifi.phonebell.data.repository.DeviceRepository
import com.arnifi.phonebell.firebase.FirebaseCoordinator
import com.arnifi.phonebell.ring.RingController
import com.arnifi.phonebell.storage.DeviceSettingsStore
import com.arnifi.phonebell.work.PhoneBellWorkScheduler
import okhttp3.OkHttpClient

/** Application-level composition root. It intentionally has no secrets; Firebase values are flavor config. */
class ArnifiPhoneBellApp : Application(), Configuration.Provider {
    lateinit var firebase: FirebaseCoordinator
        private set
    lateinit var settings: DeviceSettingsStore
        private set
    lateinit var repository: DeviceRepository
        private set
    lateinit var ringController: RingController
        private set

    override fun onCreate() {
        super.onCreate()
        settings = DeviceSettingsStore(this)
        firebase = FirebaseCoordinator(this)
        firebase.initialize()
        repository = DeviceRepository(
            firebase = firebase,
            api = PhoneBellApi(BuildConfig.API_BASE_URL, firebase, OkHttpClient()),
            settings = settings,
        )
        ringController = RingController(this)
        PhoneBellWorkScheduler.schedule(this)
    }

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setMinimumLoggingLevel(android.util.Log.INFO).build()
}
