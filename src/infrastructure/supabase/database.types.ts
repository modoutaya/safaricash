export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      audit_log: {
        Row: {
          actor: string;
          collector_id: string;
          entity_id: string;
          entity_table: string;
          entry_hash: string;
          event_id: string;
          event_type: string;
          payload: Json;
          prev_hash: string | null;
          source: string;
          timestamp: string;
        };
        Insert: {
          actor: string;
          collector_id: string;
          entity_id: string;
          entity_table: string;
          entry_hash: string;
          event_id?: string;
          event_type: string;
          payload: Json;
          prev_hash?: string | null;
          source: string;
          timestamp?: string;
        };
        Update: {
          actor?: string;
          collector_id?: string;
          entity_id?: string;
          entity_table?: string;
          entry_hash?: string;
          event_id?: string;
          event_type?: string;
          payload?: Json;
          prev_hash?: string | null;
          source?: string;
          timestamp?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      cycles: {
        Row: {
          collector_id: string;
          created_at: string;
          cycle_number: number;
          end_date: string;
          id: string;
          member_id: string;
          start_date: string;
          status: Database["public"]["Enums"]["cycles_status_enum"];
          updated_at: string;
        };
        Insert: {
          collector_id: string;
          created_at?: string;
          cycle_number: number;
          end_date: string;
          id?: string;
          member_id: string;
          start_date: string;
          status?: Database["public"]["Enums"]["cycles_status_enum"];
          updated_at?: string;
        };
        Update: {
          collector_id?: string;
          created_at?: string;
          cycle_number?: number;
          end_date?: string;
          id?: string;
          member_id?: string;
          start_date?: string;
          status?: Database["public"]["Enums"]["cycles_status_enum"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "cycles_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cycles_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "cycles_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members_decrypted";
            referencedColumns: ["id"];
          },
        ];
      };
      disputes: {
        Row: {
          collector_id: string;
          flagged_at: string;
          flagged_via: Database["public"]["Enums"]["disputes_via_enum"];
          id: string;
          notes: string | null;
          resolved_at: string | null;
          status: Database["public"]["Enums"]["disputes_status_enum"];
          transaction_id: string;
        };
        Insert: {
          collector_id: string;
          flagged_at?: string;
          flagged_via?: Database["public"]["Enums"]["disputes_via_enum"];
          id?: string;
          notes?: string | null;
          resolved_at?: string | null;
          status?: Database["public"]["Enums"]["disputes_status_enum"];
          transaction_id: string;
        };
        Update: {
          collector_id?: string;
          flagged_at?: string;
          flagged_via?: Database["public"]["Enums"]["disputes_via_enum"];
          id?: string;
          notes?: string | null;
          resolved_at?: string | null;
          status?: Database["public"]["Enums"]["disputes_status_enum"];
          transaction_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "disputes_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "disputes_transaction_id_fkey";
            columns: ["transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "disputes_transaction_id_fkey";
            columns: ["transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions_decrypted";
            referencedColumns: ["id"];
          },
        ];
      };
      members: {
        Row: {
          collector_id: string;
          created_at: string;
          created_via: Database["public"]["Enums"]["members_created_via_enum"];
          daily_amount: number;
          id: string;
          name_encrypted: string;
          phone_number_encrypted: string;
          phone_number_hash: string | null;
          status: Database["public"]["Enums"]["members_status_enum"];
          updated_at: string;
        };
        Insert: {
          collector_id: string;
          created_at?: string;
          created_via?: Database["public"]["Enums"]["members_created_via_enum"];
          daily_amount: number;
          id?: string;
          name_encrypted: string;
          phone_number_encrypted: string;
          phone_number_hash?: string | null;
          status?: Database["public"]["Enums"]["members_status_enum"];
          updated_at?: string;
        };
        Update: {
          collector_id?: string;
          created_at?: string;
          created_via?: Database["public"]["Enums"]["members_created_via_enum"];
          daily_amount?: number;
          id?: string;
          name_encrypted?: string;
          phone_number_encrypted?: string;
          phone_number_hash?: string | null;
          status?: Database["public"]["Enums"]["members_status_enum"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "members_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      sms_queue: {
        Row: {
          attempts: number;
          body: string;
          collector_id: string;
          created_at: string;
          delivered_at: string | null;
          id: string;
          last_attempt_at: string | null;
          recipient_phone: string;
          status: Database["public"]["Enums"]["sms_queue_status_enum"];
          transaction_id: string | null;
        };
        Insert: {
          attempts?: number;
          body: string;
          collector_id: string;
          created_at?: string;
          delivered_at?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          recipient_phone: string;
          status?: Database["public"]["Enums"]["sms_queue_status_enum"];
          transaction_id?: string | null;
        };
        Update: {
          attempts?: number;
          body?: string;
          collector_id?: string;
          created_at?: string;
          delivered_at?: string | null;
          id?: string;
          last_attempt_at?: string | null;
          recipient_phone?: string;
          status?: Database["public"]["Enums"]["sms_queue_status_enum"];
          transaction_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "sms_queue_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_queue_transaction_id_fkey";
            columns: ["transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_queue_transaction_id_fkey";
            columns: ["transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions_decrypted";
            referencedColumns: ["id"];
          },
        ];
      };
      transactions: {
        Row: {
          amount_encrypted: string;
          collector_id: string;
          created_at: string;
          cycle_day: number;
          cycle_id: string;
          days_covered: number;
          id: string;
          kind: Database["public"]["Enums"]["transactions_kind_enum"];
          member_id: string;
          source: Database["public"]["Enums"]["transactions_source_enum"];
          undone_at: string | null;
          updated_at: string;
        };
        Insert: {
          amount_encrypted: string;
          collector_id: string;
          created_at?: string;
          cycle_day: number;
          cycle_id: string;
          days_covered?: number;
          id?: string;
          kind: Database["public"]["Enums"]["transactions_kind_enum"];
          member_id: string;
          source?: Database["public"]["Enums"]["transactions_source_enum"];
          undone_at?: string | null;
          updated_at?: string;
        };
        Update: {
          amount_encrypted?: string;
          collector_id?: string;
          created_at?: string;
          cycle_day?: number;
          cycle_id?: string;
          days_covered?: number;
          id?: string;
          kind?: Database["public"]["Enums"]["transactions_kind_enum"];
          member_id?: string;
          source?: Database["public"]["Enums"]["transactions_source_enum"];
          undone_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transactions_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_cycle_id_fkey";
            columns: ["cycle_id"];
            isOneToOne: false;
            referencedRelation: "cycles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members_decrypted";
            referencedColumns: ["id"];
          },
        ];
      };
      users: {
        Row: {
          created_at: string;
          id: string;
          phone_number: string;
          role: Database["public"]["Enums"]["users_role_enum"];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id: string;
          phone_number: string;
          role?: Database["public"]["Enums"]["users_role_enum"];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          phone_number?: string;
          role?: Database["public"]["Enums"]["users_role_enum"];
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      members_decrypted: {
        Row: {
          collector_id: string | null;
          created_at: string | null;
          daily_amount: number | null;
          id: string | null;
          name: string | null;
          phone_number: string | null;
          status: Database["public"]["Enums"]["members_status_enum"] | null;
          updated_at: string | null;
        };
        Insert: {
          collector_id?: string | null;
          created_at?: string | null;
          daily_amount?: number | null;
          id?: string | null;
          name?: never;
          phone_number?: never;
          status?: Database["public"]["Enums"]["members_status_enum"] | null;
          updated_at?: string | null;
        };
        Update: {
          collector_id?: string | null;
          created_at?: string | null;
          daily_amount?: number | null;
          id?: string | null;
          name?: never;
          phone_number?: never;
          status?: Database["public"]["Enums"]["members_status_enum"] | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "members_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      transactions_decrypted: {
        Row: {
          amount: number | null;
          collector_id: string | null;
          created_at: string | null;
          cycle_day: number | null;
          cycle_id: string | null;
          days_covered: number | null;
          id: string | null;
          kind: Database["public"]["Enums"]["transactions_kind_enum"] | null;
          member_id: string | null;
          source: Database["public"]["Enums"]["transactions_source_enum"] | null;
          updated_at: string | null;
        };
        Insert: {
          amount?: never;
          collector_id?: string | null;
          created_at?: string | null;
          cycle_day?: number | null;
          cycle_id?: string | null;
          days_covered?: number | null;
          id?: string | null;
          kind?: Database["public"]["Enums"]["transactions_kind_enum"] | null;
          member_id?: string | null;
          source?: Database["public"]["Enums"]["transactions_source_enum"] | null;
          updated_at?: string | null;
        };
        Update: {
          amount?: never;
          collector_id?: string | null;
          created_at?: string | null;
          cycle_day?: number | null;
          cycle_id?: string | null;
          days_covered?: number | null;
          id?: string | null;
          kind?: Database["public"]["Enums"]["transactions_kind_enum"] | null;
          member_id?: string | null;
          source?: Database["public"]["Enums"]["transactions_source_enum"] | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "transactions_collector_id_fkey";
            columns: ["collector_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_cycle_id_fkey";
            columns: ["cycle_id"];
            isOneToOne: false;
            referencedRelation: "cycles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_member_id_fkey";
            columns: ["member_id"];
            isOneToOne: false;
            referencedRelation: "members_decrypted";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      canonical_jsonb: { Args: { j: Json }; Returns: string };
      create_member_with_cycle: {
        Args: {
          p_created_via?: Database["public"]["Enums"]["members_created_via_enum"];
          p_daily_amount: number;
          p_name: string;
          p_phone_number: string;
        };
        Returns: string;
      };
      delete_member: { Args: { p_id: string }; Returns: undefined };
      emit_session_event: { Args: { p_reason: string }; Returns: undefined };
      record_contribution: {
        Args: {
          p_amount: number;
          p_cycle_day: number;
          p_cycle_id: string;
          p_member_id: string;
        };
        Returns: string;
      };
      record_rattrapage: {
        Args: {
          p_cycle_day: number;
          p_cycle_id: string;
          p_daily_amount: number;
          p_days_covered: number;
          p_member_id: string;
        };
        Returns: string;
      };
      restart_member_cycle: { Args: { p_member_id: string }; Returns: string };
      show_limit: { Args: never; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
      undo_transaction: {
        Args: { p_transaction_id: string };
        Returns: undefined;
      };
      update_member: {
        Args: {
          p_daily_amount: number;
          p_id: string;
          p_name: string;
          p_phone_number: string;
        };
        Returns: undefined;
      };
      vault_decrypt: { Args: { secret_id: string }; Returns: string };
      vault_encrypt: { Args: { plaintext: string }; Returns: string };
    };
    Enums: {
      cycles_status_enum: "active" | "with_advance" | "completed" | "settled";
      disputes_status_enum: "open" | "resolved" | "dismissed";
      disputes_via_enum: "receipt_url" | "support_email" | "support_phone";
      members_created_via_enum: "manual" | "contacts_import";
      members_status_enum: "active" | "paused" | "completed" | "deleted";
      sms_queue_status_enum: "queued" | "sent" | "delivered" | "failed" | "abandoned";
      transactions_kind_enum: "contribution" | "rattrapage" | "advance";
      transactions_source_enum: "online" | "offline_reconciled";
      users_role_enum: "collector" | "super_admin";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      cycles_status_enum: ["active", "with_advance", "completed", "settled"],
      disputes_status_enum: ["open", "resolved", "dismissed"],
      disputes_via_enum: ["receipt_url", "support_email", "support_phone"],
      members_created_via_enum: ["manual", "contacts_import"],
      members_status_enum: ["active", "paused", "completed", "deleted"],
      sms_queue_status_enum: ["queued", "sent", "delivered", "failed", "abandoned"],
      transactions_kind_enum: ["contribution", "rattrapage", "advance"],
      transactions_source_enum: ["online", "offline_reconciled"],
      users_role_enum: ["collector", "super_admin"],
    },
  },
} as const;
