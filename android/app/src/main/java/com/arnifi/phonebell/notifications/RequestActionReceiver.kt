package com.arnifi.phonebell.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.arnifi.phonebell.ArnifiPhoneBellApp
import com.arnifi.phonebell.ring.RingController
import com.arnifi.phonebell.work.CallbackAction
import com.arnifi.phonebell.work.PhoneBellWorkScheduler

class RequestActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        if (intent.action == ACTION_ACKNOWLEDGE) {
            (context.applicationContext as? ArnifiPhoneBellApp)?.ringController?.stop(id)
            PhoneBellWorkScheduler.enqueueCallback(context.applicationContext, id, CallbackAction.ACKNOWLEDGE)
        }
    }

    companion object {
        const val ACTION_ACKNOWLEDGE = "com.arnifi.phonebell.action.ACKNOWLEDGE"
        const val EXTRA_REQUEST_ID = "request_id"
    }
}
