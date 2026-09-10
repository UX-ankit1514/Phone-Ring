package com.arnifi.phonebell.storage

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DeviceSettingsStoreTest {
    @Test fun requestDedupeIsStableAcrossRepeatedDelivery() = runBlocking {
        val store = DeviceSettingsStore(ApplicationProvider.getApplicationContext<Context>())
        val requestId = "test_${UUID.randomUUID()}"
        assertTrue(store.markRequestHandledIfNew(requestId))
        assertFalse(store.markRequestHandledIfNew(requestId))
    }
}
